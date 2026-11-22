// T006 executable contract implemented by T015. Factory accepts spawn,
// readRssBytes, temporaryRoot and test-only limits; validate(Buffer) returns
// {sizeBytes, sha256}. No storage client belongs to the validator.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import test from 'node:test';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';

const moduleUrl = new URL(
  '../../../src/app/services/BudgetPdfValidationService.js',
  import.meta.url,
);
const code = (expected) => (error) => error.code === expected;

async function scenario(t, outcomes, { rssBytes = 0, limits = {} } = {}) {
  assert.ok(
    existsSync(moduleUrl),
    'T015_PENDING: secure qpdf adapter is not implemented',
  );
  const { createBudgetPdfValidationService } = await import(moduleUrl.href);
  const root = mkdtempSync(join(tmpdir(), 'feature005-unit-'));
  const calls = [];
  let running = 0;
  let peak = 0;
  const spawn = (executable, args, options) => {
    assert.equal(executable, '/usr/bin/qpdf');
    assert.equal(options.shell, false);
    assert.ok(['--requires-password', '--check'].includes(args[0]));
    assert.equal(args.length, 2);
    assert.ok(isAbsolute(args[1]));
    assert.equal(statSync(args[1]).mode & 0o777, 0o600);
    assert.equal(statSync(join(args[1], '..')).mode & 0o777, 0o700);
    assert.equal(readFileSync(args[1]).subarray(0, 5).toString(), '%PDF-');
    assert.equal(options.stdio[0], 'ignore');
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.QPDF_OPTIONS, undefined);
    calls.push(args);
    const outcome = outcomes.shift() ?? { exit: 0 };
    if (outcome.throwCode)
      throw Object.assign(new Error('synthetic process failure'), {
        code: outcome.throwCode,
      });
    const child = new EventEmitter();
    child.pid = 123456;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    running++;
    peak = Math.max(peak, running);
    let closed = false;
    const close = (exit, signal) => {
      if (closed) return;
      closed = true;
      running--;
      child.emit('exit', exit, signal);
      child.emit('close', exit, signal);
    };
    child.kill = (signal) => {
      if (!outcome.ignoreTerm || signal === 'SIGKILL')
        setImmediate(() => close(null, signal));
      return true;
    };
    const finish = () => {
      if (closed) return;
      if (outcome.output)
        child[outcome.channel ?? 'stdout'].write(
          Buffer.alloc(outcome.output, 120),
        );
      if (outcome.errorCode)
        child.emit(
          'error',
          Object.assign(new Error('synthetic failure'), {
            code: outcome.errorCode,
          }),
        );
      if (!outcome.hang) close(outcome.exit ?? null, outcome.signal ?? null);
    };
    if (outcome.delayMs) setTimeout(finish, outcome.delayMs);
    else setImmediate(finish);
    return child;
  };
  const service = createBudgetPdfValidationService({
    spawn,
    readRssBytes: async () => rssBytes,
    executable: '/usr/bin/qpdf',
    temporaryRoot: root,
    limits: {
      timeoutMs: 100,
      rssPollMs: 5,
      killGraceMs: 5,
      maxOutputBytes: 65536,
      maxRssBytes: 268435456,
      concurrency: 2,
      ...limits,
    },
  });
  t.after(() => {
    try {
      assert.equal(running, 0, 'await child termination before cleanup');
      assert.deepEqual(readdirSync(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  return { service, calls, peak: () => peak };
}

test('T006 password probe 2/3 each require independent check=0; exact bytes/hash and cleanup', async (t) => {
  for (const exit of [2, 3]) {
    const context = await scenario(t, [{ exit }, { exit: 0 }]);
    const bytes = buildPdf();
    const result = await context.service.validate(bytes);
    assert.equal(result.sizeBytes, bytes.length);
    assert.equal(
      result.sha256,
      createHash('sha256').update(bytes).digest('hex'),
    );
    assert.deepEqual(
      context.calls.map((call) => call[0]),
      ['--requires-password', '--check'],
    );
    assert.equal(context.calls[0][1], context.calls[1][1]);
  }
});

test('T006 password=0 rejects; check=2/3 rejects even after probe=2/3; unknown exit rejects', async (t) => {
  for (const [outcomes, expected, count] of [
    [[{ exit: 0 }], 'passwordRequired', 1],
    [[{ exit: 1 }], 'validatorFailed', 1],
    ...[2, 3].flatMap((probe) =>
      [2, 3, 1].map((check) => [
        [{ exit: probe }, { exit: check }],
        check === 1 ? 'validatorFailed' : 'invalidPdf',
        2,
      ]),
    ),
  ]) {
    const context = await scenario(t, outcomes);
    let puts = 0;
    await assert.rejects(
      context.service.validate(buildPdf()).then(() => {
        puts++;
      }),
      code(expected),
    );
    assert.equal(puts, 0);
    assert.equal(context.calls.length, count);
  }
});

test('T006 empty/non-PDF/oversize fail before spawn; exact 10 MiB is eligible', async (t) => {
  // Size eligibility is not a 100ms filesystem performance assertion on a
  // one-CPU container. Dedicated deadline tests below retain short deadlines.
  const context = await scenario(t, [{ exit: 2 }, { exit: 0 }], {
    limits: { timeoutMs: 2000 },
  });
  for (const [bytes, expected] of [
    [Buffer.alloc(0), 'invalidPdf'],
    [Buffer.from('not a pdf'), 'unsupportedMediaType'],
    [buildPdf({ size: 10485761 }), 'fileTooLarge'],
  ]) {
    await assert.rejects(context.service.validate(bytes), code(expected));
    assert.equal(context.calls.length, 0);
  }
  assert.equal(
    (await context.service.validate(buildPdf({ size: 10485760 }))).sizeBytes,
    10485760,
  );
});

test('T006 missing/denied binary, asynchronous error, crash and signal fail closed without leaking raw details', async (t) => {
  for (const outcome of [
    { throwCode: 'ENOENT' },
    { throwCode: 'EACCES' },
    { errorCode: 'ENOENT', hang: true },
    { signal: 'SIGSEGV' },
    { exit: 139 },
  ]) {
    const context = await scenario(t, [outcome]);
    await assert.rejects(context.service.validate(buildPdf()), (error) => {
      assert.ok(
        ['validatorUnavailable', 'validatorFailed'].includes(error.code),
      );
      assert.equal(String(error.message).includes('synthetic'), false);
      return true;
    });
  }
});

test('T006 timeout kills even a child ignoring SIGTERM, awaits close then cleans temporary files', async (t) => {
  const context = await scenario(t, [{ hang: true, ignoreTerm: true }], {
    limits: { timeoutMs: 20 },
  });
  await assert.rejects(
    context.service.validate(buildPdf()),
    code('validatorTimeout'),
  );
});

test('T006 deadline is aggregate, not restarted for the second process', async (t) => {
  const context = await scenario(
    t,
    [
      { exit: 2, delayMs: 35 },
      { exit: 0, delayMs: 35 },
    ],
    { limits: { timeoutMs: 60 } },
  );
  await assert.rejects(
    context.service.validate(buildPdf()),
    code('validatorTimeout'),
  );
  assert.equal(context.calls.length, 2);
});

test('T006 stdout/stderr over 64 KiB and RSS over 256 MiB kill/reject and clean', async (t) => {
  for (const channel of ['stdout', 'stderr']) {
    const context = await scenario(t, [{ output: 65537, channel, hang: true }]);
    await assert.rejects(
      context.service.validate(buildPdf()),
      code('validatorFailed'),
    );
  }
  const context = await scenario(t, [{ hang: true }], { rssBytes: 268435457 });
  await assert.rejects(
    context.service.validate(buildPdf()),
    code('validatorFailed'),
  );
});

test('T006 output and RSS exactly at their limits remain eligible; failure in second process also cleans', async (t) => {
  const allowed = await scenario(
    t,
    [
      { exit: 2, output: 65536 },
      { exit: 0, output: 65536, channel: 'stderr' },
    ],
    { rssBytes: 268435456 },
  );
  await allowed.service.validate(buildPdf());
  const failed = await scenario(t, [{ exit: 3 }, { throwCode: 'EACCES' }]);
  await assert.rejects(
    failed.service.validate(buildPdf()),
    code('validatorUnavailable'),
  );
});

test('T006 two concurrent validations maximum; excess fails with no third child', async (t) => {
  const context = await scenario(t, [{ hang: true }, { hang: true }], {
    limits: { timeoutMs: 30 },
  });
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () => context.service.validate(buildPdf())),
  );
  assert.equal(context.peak(), 2);
  assert.equal(
    results.filter(
      (result) =>
        result.status === 'rejected' && result.reason.code === 'resourceLimit',
    ).length,
    1,
  );
  assert.equal(
    results.every((result) => result.status === 'rejected'),
    true,
  );
});
