import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, mkdir, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBudgetPdfValidationService } from '../../../src/app/services/BudgetPdfValidationService.js';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';

test('T015 real spawn ENOENT fails closed, removes private files and releases capacity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'budget-safety-'));
  try {
    const service = createBudgetPdfValidationService({
      executable: join(root, 'missing-qpdf'),
      temporaryRoot: root,
    });
    for (let i = 0; i < 3; i++)
      await assert.rejects(
        service.validate(buildPdf()),
        (error) => error.code === 'validatorUnavailable',
      );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('T015 rejects high-bit fake signature, caller-controlled binary and weakened limits before spawn', async () => {
  let calls = 0;
  const service = createBudgetPdfValidationService({
    spawn: () => {
      calls++;
      throw new Error('unexpected spawn');
    },
  });
  const bytes = buildPdf();
  bytes[0] |= 0x80;
  await assert.rejects(
    service.validate(bytes),
    (error) => error.code === 'unsupportedMediaType',
  );
  assert.equal(calls, 0);
  assert.throws(
    () => createBudgetPdfValidationService({ executable: 'qpdf' }),
    /validatorUnavailable/,
  );
  assert.throws(
    () => createBudgetPdfValidationService({ limits: { concurrency: 3 } }),
    /validatorUnavailable/,
  );
  assert.throws(
    () =>
      createBudgetPdfValidationService({ limits: { maxOutputBytes: 65537 } }),
    /validatorUnavailable/,
  );
});

test('T015 aborted request creates no process and cleans its private temporary directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'budget-safety-'));
  try {
    let calls = 0;
    const service = createBudgetPdfValidationService({
      temporaryRoot: root,
      spawn: () => {
        calls++;
        throw new Error('unexpected spawn');
      },
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      service.validate(buildPdf(), { signal: controller.signal }),
      (error) => error.code === 'validatorFailed',
    );
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('T015 startup sweep retains live PID leases, recent directories, unrelated paths and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'budget-safety-'));
  try {
    const live = `budget-pdf-validation-${process.pid}-live`;
    const recent = 'budget-pdf-validation-2147483647-recent';
    const stale = 'budget-pdf-validation-2147483647-stale';
    for (const name of [live, recent, stale, 'unrelated'])
      await mkdir(join(root, name));
    const old = new Date(Date.now() - 2 * 86400000);
    for (const name of [live, stale]) await utimes(join(root, name), old, old);
    await symlink(
      join(root, 'unrelated'),
      join(root, 'budget-pdf-validation-2147483647-link'),
    );
    await createBudgetPdfValidationService({
      temporaryRoot: root,
    }).sweepStaleTemporaries();
    assert.deepEqual(
      (await readdir(root)).sort(),
      [
        live,
        recent,
        'unrelated',
        'budget-pdf-validation-2147483647-link',
      ].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
