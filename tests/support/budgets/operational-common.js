import { spawn } from 'node:child_process';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
export const PG_IMAGE =
  'sha256:eb0fb2377534e65aad04f37838956b3dfb888e1a3dd3c1acf957bc6557eb6c7d';
export const MINIO_IMAGE =
  'sha256:95713554f0875afdab500a38ccae2fa397b461c9867105072aca2204a938d6f9';
export const API_IMAGE =
  'sha256:9df6780832b95564d1a5ed153eebbf36bdce8b2ef12e0f295614a977134d7440';
export const isMain = (url) =>
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url);
export function resourceProvenAbsent(result, kind, name) {
  if (result.code !== 1) return false;
  return [
    `No such ${kind}: ${name}`,
    `No such object: ${name}`,
    `${kind} ${name} not found`,
    ...(kind === 'volume' ? [`get ${name}: no such volume`] : []),
  ].some((message) => result.output.includes(message));
}
export const envText = (values) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
export async function privatePath(path, directory = false) {
  const info = await lstat(path);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(directory ? info.isDirectory() : info.isFile(), true);
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o077, 0);
  const actual = await realpath(path);
  assert.ok(actual !== ROOT && !actual.startsWith(ROOT + '/'));
  return actual;
}
export async function save(path, value, exclusive = false) {
  await writeFile(
    path,
    typeof value === 'string' || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(value, null, 2),
    { mode: 0o600, flag: exclusive ? 'wx' : 'w' },
  );
}
// No shell; subprocess diagnostics stay private. Signal relay also covers worker.
export function execute(
  command,
  args,
  { input, timeout = 180000, relay = false } = {},
) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let output = '',
      overflow = false;
    const collect = (data) => {
      if (output.length + data.length > 16 * 1024 * 1024) {
        overflow = true;
        child.kill('SIGKILL');
      } else output += data.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const term = () => child.kill('SIGTERM'),
      int = () => child.kill('SIGINT');
    if (relay) {
      process.on('SIGTERM', term);
      process.on('SIGINT', int);
    }
    const timer = timeout
      ? setTimeout(() => child.kill('SIGKILL'), timeout)
      : null;
    let failed = false;
    child.on('error', () => {
      failed = true;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (relay) {
        process.off('SIGTERM', term);
        process.off('SIGINT', int);
      }
      resolveResult({ code: failed || overflow || signal ? 21 : code, output });
    });
  });
}
export async function docker(args, options) {
  const result = await execute('docker', args, options);
  if (result.code !== 0) throw new Error('FEATURE005_DOCKER_OPERATION_FAILED');
  return result.output.trim();
}
export function containerBase(network) {
  return [
    'run',
    '--rm',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--network',
    network,
    '--memory',
    '512m',
    '--memory-swap',
    '512m',
    '--cpus',
    '1',
    '--pids-limit',
    '64',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
    ...['src', 'tests', 'specs'].flatMap((name) => [
      '--mount',
      `type=bind,src=${ROOT}/${name},dst=/app/${name},readonly`,
    ]),
  ];
}
