import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBudgetPdfValidationService } from '../../../src/app/services/BudgetPdfValidationService.js';
import { createBudgetPdfRuntimeService } from '../../../src/app/services/BudgetPdfRuntimeService.js';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';

test('T022 actual qpdf 12.3.2 under cgroup, timeout/RSS/concurrency/private temp cleanup', async (t) => {
  assert.equal(process.getuid(), 1000);
  const root = await mkdtemp(join(tmpdir(), 't022-runtime-'));
  try {
    await t.test(
      'all synthetic fixtures exercise actual password/check semantics, including empty password and warnings',
      async () => {
        const manifest = JSON.parse(
          await readFile(
            new URL('../../fixtures/budgets/manifest.json', import.meta.url),
          ),
        );
        const service = createBudgetPdfValidationService({
          temporaryRoot: root,
        });
        for (const fixture of manifest.fixtures) {
          const input = await readFile(
            new URL(`../../fixtures/budgets/${fixture.file}`, import.meta.url),
          );
          if (fixture.expectedUploadResult === 'accept')
            assert.equal(
              (await service.validate(input)).sizeBytes,
              input.length,
            );
          else
            await assert.rejects(
              service.validate(input),
              (error) => typeof error.code === 'string',
            );
        }
        assert.deepEqual(await readdir(root), []);
      },
    );
    await t.test(
      'real version and smoke, accepted 10MiB and rejected excess',
      async () => {
        assert.deepEqual(
          await createBudgetPdfRuntimeService().ensureUploadsReady(),
          { ready: true, version: '12.3.2' },
        );
        const service = createBudgetPdfValidationService({
          temporaryRoot: root,
        });
        assert.equal(
          (await service.validate(buildPdf({ size: 10485760 }))).sizeBytes,
          10485760,
        );
        await assert.rejects(service.validate(buildPdf({ size: 10485761 })), {
          code: 'fileTooLarge',
        });
        assert.deepEqual(await readdir(root), []);
      },
    );
    await t.test(
      'actual spawned qpdf timeout killed and awaited, no fake process',
      async () => {
        const service = createBudgetPdfValidationService({
          temporaryRoot: root,
          limits: { timeoutMs: 1 },
        });
        await assert.rejects(service.validate(buildPdf({ size: 10485760 })), {
          code: 'validatorTimeout',
        });
        assert.deepEqual(await readdir(root), []);
      },
    );
    await t.test(
      'actual qpdf RSS ceiling enforced by real /proc watchdog',
      async () => {
        const service = createBudgetPdfValidationService({
          temporaryRoot: root,
          limits: { maxRssBytes: 1, rssPollMs: 1 },
        });
        await assert.rejects(service.validate(buildPdf({ size: 10485760 })), {
          code: 'validatorFailed',
        });
        assert.deepEqual(await readdir(root), []);
      },
    );
    await t.test(
      'two real concurrent jobs; third rejected; active private modes and cleanup',
      async () => {
        const service = createBudgetPdfValidationService({
          temporaryRoot: root,
        });
        const bytes = buildPdf({ size: 10485760 });
        const first = service.validate(bytes),
          second = service.validate(bytes);
        await assert.rejects(service.validate(bytes), {
          code: 'resourceLimit',
        });
        for (const name of await readdir(root)) {
          assert.equal((await stat(join(root, name))).mode & 0o777, 0o700);
          for (const file of await readdir(join(root, name)))
            assert.equal(
              (await stat(join(root, name, file))).mode & 0o777,
              0o600,
            );
        }
        await Promise.all([first, second]);
        assert.deepEqual(await readdir(root), []);
      },
    );
    await t.test(
      'missing actual binary fail closed repeatedly, no retained files or capacity',
      async () => {
        const service = createBudgetPdfValidationService({
          executable: join(root, 'missing'),
          temporaryRoot: root,
        });
        for (let i = 0; i < 3; i++)
          await assert.rejects(service.validate(buildPdf()), {
            code: 'validatorUnavailable',
          });
        assert.deepEqual(await readdir(root), []);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
