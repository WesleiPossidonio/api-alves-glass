import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TEMP = 64 * 1024 * 1024;
let active = 0;
let reservedBytes = 0;
const activeDirectories = new Set();

export class BudgetPdfValidationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.status =
      {
        invalidPdf: 422,
        passwordRequired: 422,
        unsupportedMediaType: 415,
        fileTooLarge: 413,
        resourceLimit: 429,
      }[code] ?? 503;
  }
}
const failure = (code) => new BudgetPdfValidationError(code);
const processError = (error) =>
  failure(
    ['ENOENT', 'EACCES'].includes(error?.code)
      ? 'validatorUnavailable'
      : 'validatorFailed',
  );

export async function linuxRssBytes(
  pid,
  readStatus = readFile,
  probe = process.kill,
) {
  let status;
  try {
    status = await readStatus(`/proc/${pid}/status`, 'utf8');
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) {
      try {
        probe(pid, 0);
      } catch (probe) {
        if (probe.code === 'ESRCH') return 0; // OS exit can precede Node exit/close events.
      }
    }
    throw error;
  }
  const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  // Reaped/zombie qpdf has no resident memory, but its exit/close events still
  // determine success/failure and are awaited before temporary deletion.
  if (!match && /^State:\s+Z\b/m.test(status)) return 0;
  if (!match) {
    // Linux can release mm while status still reports R during exit. Confirm
    // the independently read resident-page count, never assume missing RSS=0.
    try {
      const statm = await readStatus(`/proc/${pid}/statm`, 'utf8');
      if (/^0\s+0(?:\s+0)*\s*$/.test(statm)) return 0;
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) {
        try {
          probe(pid, 0);
        } catch (gone) {
          if (gone.code === 'ESRCH') return 0;
        }
      }
      throw error;
    }
  }
  if (!match) throw failure('validatorFailed');
  return Number(match[1]) * 1024;
}

export function createBudgetPdfValidationService({
  spawn = spawnProcess,
  readRssBytes = linuxRssBytes,
  executable = '/usr/bin/qpdf',
  temporaryRoot = tmpdir(),
  limits = {},
} = {}) {
  if (!isAbsolute(executable) || !isAbsolute(temporaryRoot))
    throw failure('validatorUnavailable');
  const defaults = {
    timeoutMs: 10000,
    rssPollMs: 50,
    killGraceMs: 100,
    maxOutputBytes: 65536,
    maxRssBytes: 256 * 1024 * 1024,
    concurrency: 2,
  };
  // Injection can tighten limits for tests, never weaken production ceilings.
  const settings = Object.fromEntries(
    Object.entries(defaults).map(([key, ceiling]) => {
      const value = limits[key] ?? ceiling;
      if (!Number.isInteger(value) || value <= 0 || value > ceiling)
        throw failure('validatorUnavailable');
      return [key, value];
    }),
  );

  async function sweepStaleTemporaries() {
    // PID lease + age: only dead owners, never an active upload or symlink.
    // A reused live PID is conservatively retained. Dedicated prefix only.
    for (const name of await readdir(temporaryRoot)) {
      const match = name.match(/^budget-pdf-validation-(\d+)-[A-Za-z0-9]+$/);
      if (!match) continue;
      const path = join(temporaryRoot, name);
      if (activeDirectories.has(path)) continue;
      try {
        const stat = await lstat(path);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid() ||
          Date.now() - stat.mtimeMs < 86400000
        )
          continue;
        try {
          process.kill(Number(match[1]), 0);
          continue;
        } catch (error) {
          if (error.code !== 'ESRCH') continue;
        }
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw failure('validatorFailed');
      }
    }
  }

  function run(stage, path, deadline, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(failure('validatorFailed'));
      if (performance.now() >= deadline)
        return reject(failure('validatorTimeout'));
      let child;
      try {
        child = spawn(executable, [stage, path], {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { LANG: 'C', LC_ALL: 'C' },
        });
      } catch (error) {
        reject(processError(error));
        return;
      }
      let closed = false;
      let reason;
      let escalation;
      let polling = false;
      const terminate = (error) => {
        if (closed || reason) return;
        reason = error;
        try {
          child.kill('SIGTERM');
        } catch {
          /* close/error still determines termination */
        }
        escalation = setTimeout(() => {
          if (!closed) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* never clean a live child */
            }
          }
        }, settings.killGraceMs);
      };
      const abort = () => terminate(failure('validatorFailed'));
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => terminate(failure('validatorTimeout')),
        Math.max(1, deadline - performance.now()),
      );
      const watchdog = setInterval(async () => {
        if (closed || polling || !child.pid) return;
        polling = true;
        try {
          const rss = await readRssBytes(child.pid);
          if (!Number.isFinite(rss) || rss < 0 || rss > settings.maxRssBytes)
            terminate(failure('validatorFailed'));
        } catch (error) {
          // /proc can disappear between exit and close. Other failures fail closed.
          if (
            !closed &&
            !(
              error.code === 'ENOENT' &&
              (child.exitCode != null || child.signalCode != null)
            )
          ) {
            terminate(failure('validatorFailed'));
          }
        } finally {
          polling = false;
        }
      }, settings.rssPollMs);
      for (const stream of [child.stdout, child.stderr]) {
        let count = 0;
        stream.on('data', (data) => {
          count += Buffer.byteLength(data);
          if (count > settings.maxOutputBytes)
            terminate(failure('validatorFailed'));
        });
        stream.on('error', () => terminate(failure('validatorFailed')));
      }
      child.on('error', (error) => terminate(processError(error)));
      child.once('close', (exit, childSignal) => {
        closed = true;
        clearTimeout(timer);
        clearTimeout(escalation);
        clearInterval(watchdog);
        signal?.removeEventListener('abort', abort);
        if (reason) reject(reason);
        else if (childSignal || !Number.isInteger(exit))
          reject(failure('validatorFailed'));
        else resolve(exit);
      });
      if (signal?.aborted) abort();
    });
  }

  let startup;
  return {
    sweepStaleTemporaries,
    async validate(input, { signal } = {}) {
      if (!Buffer.isBuffer(input) || input.length === 0)
        throw failure('invalidPdf');
      if (input.length > MAX_FILE) throw failure('fileTooLarge');
      if (!input.subarray(0, 5).equals(Buffer.from('%PDF-')))
        throw failure('unsupportedMediaType');
      if (
        active >= settings.concurrency ||
        reservedBytes + input.length > MAX_TEMP
      )
        throw failure('resourceLimit');
      active++;
      reservedBytes += input.length;
      const bytes = Buffer.from(input); // never validate bytes the caller can mutate concurrently
      const deadline = performance.now() + settings.timeoutMs;
      let directory;
      try {
        startup ??= sweepStaleTemporaries();
        await startup;
        directory = await mkdtemp(
          join(temporaryRoot, `budget-pdf-validation-${process.pid}-`),
        );
        activeDirectories.add(directory);
        await chmod(directory, 0o700);
        const path = join(directory, 'document.pdf');
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
        const probe = await run('--requires-password', path, deadline, signal);
        if (probe === 0) throw failure('passwordRequired');
        if (![2, 3].includes(probe)) throw failure('validatorFailed');
        const check = await run('--check', path, deadline, signal);
        if ([2, 3].includes(check)) throw failure('invalidPdf');
        if (check !== 0) throw failure('validatorFailed');
        const actual = await readFile(path);
        if (!actual.equals(bytes)) throw failure('validatorFailed');
        if (signal?.aborted) throw failure('validatorFailed');
        if (performance.now() >= deadline) throw failure('validatorTimeout');
        return {
          sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes,
        };
      } catch (error) {
        throw error instanceof BudgetPdfValidationError
          ? error
          : processError(error);
      } finally {
        try {
          if (directory) await rm(directory, { recursive: true, force: true });
        } catch {
          throw failure('validatorFailed');
        } finally {
          activeDirectories.delete(directory);
          reservedBytes -= bytes.length;
          active--;
        }
      }
    },
  };
}
