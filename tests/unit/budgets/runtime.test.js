import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetPdfRuntimeService } from '../../../src/app/services/BudgetPdfRuntimeService.js';

test('T016 isolated pinned version + semantic smoke; concurrent preflight single-flight', async () => {
  let calls = 0;
  let smoke = 0;
  const service = createBudgetPdfRuntimeService({
    execute: async (path, argv, options) => {
      calls++;
      assert.equal(path, '/usr/bin/qpdf');
      assert.deepEqual(argv, ['--version']);
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 10000);
      assert.equal(options.env.NODE_OPTIONS, undefined);
      return { stdout: 'qpdf version 12.3.2\n' };
    },
    validator: {
      validate: async (bytes) => {
        smoke++;
        assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      },
    },
  });
  assert.deepEqual(
    await Promise.all([
      service.ensureUploadsReady(),
      service.ensureUploadsReady(),
    ]),
    [
      { ready: true, version: '12.3.2' },
      { ready: true, version: '12.3.2' },
    ],
  );
  assert.equal(calls, 1);
  assert.equal(smoke, 1);
});
test('T016 missing/wrong runtime or failed smoke fail closed, retry allowed, no global startup', async () => {
  for (const stdout of [
    'qpdf version 12.1.0\n',
    'qpdf version 12.3.3\n',
    'qpdf version 12.3.20\n',
    'untrusted',
  ]) {
    const service = createBudgetPdfRuntimeService({
      execute: async () => ({ stdout }),
      validator: { validate: async () => assert.fail('no smoke') },
    });
    await assert.rejects(service.ensureUploadsReady(), {
      code: 'validatorUnavailable',
    });
  }
  let calls = 0;
  const service = createBudgetPdfRuntimeService({
    execute: async () => {
      calls++;
      throw new Error('/secret');
    },
  });
  await assert.rejects(service.ensureUploadsReady(), {
    code: 'validatorUnavailable',
  });
  await assert.rejects(service.ensureUploadsReady(), {
    code: 'validatorUnavailable',
  });
  assert.equal(calls, 2);
  const smokeFail = createBudgetPdfRuntimeService({
    execute: async () => ({ stdout: 'qpdf version 12.3.2\n' }),
    validator: {
      validate: async () => {
        throw new Error();
      },
    },
  });
  await assert.rejects(smokeFail.ensureUploadsReady(), {
    code: 'validatorUnavailable',
  });
});
