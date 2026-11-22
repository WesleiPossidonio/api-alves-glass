import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { matrixFixture } from '../../support/budgets/matrix-fixture.js';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';
import { createBudgetPdfValidationService } from '../../../src/app/services/BudgetPdfValidationService.js';

test('T022 bounded qpdf/upload pressure actual cgroup metrics and repeated failure recovery', async () => {
  const f = await matrixFixture(),
    root = await mkdtemp(join(tmpdir(), 't022-pressure-'));
  const bytes = buildPdf({ size: 10 * 1024 * 1024 });
  let peakMemory = 0,
    peakChildren = 0,
    peakTempBytes = 0,
    peakQpdfRss = 0;
  let sampling = false;
  const start = performance.now();
  async function sample() {
    if (sampling) return;
    sampling = true;
    try {
      peakMemory = Math.max(
        peakMemory,
        Number(await readFile('/sys/fs/cgroup/memory.current', 'utf8')),
      );
      const children = (
        await readFile(`/proc/self/task/${process.pid}/children`, 'utf8')
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      peakChildren = Math.max(peakChildren, children.length);
      for (const pid of children) {
        try {
          const status = await readFile(`/proc/${pid}/status`, 'utf8');
          const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
          if (rss) peakQpdfRss = Math.max(peakQpdfRss, Number(rss[1]) * 1024);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      let size = 0;
      for (const name of await readdir(root)) {
        try {
          size += (await readFile(join(root, name, 'document.pdf'))).length;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      peakTempBytes = Math.max(peakTempBytes, size);
    } finally {
      sampling = false;
    }
  }
  const timer = setInterval(() => sample().catch(() => {}), 5);
  let accepted = 0,
    rejected = 0,
    timeouts = 0;
  try {
    assert.equal(
      (await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(),
      '536870912',
    );
    for (let round = 0; round < 4; round++) {
      const validator = createBudgetPdfValidationService({
        temporaryRoot: root,
      });
      const first = validator.validate(bytes),
        second = validator.validate(bytes);
      await assert.rejects(validator.validate(bytes), {
        code: 'resourceLimit',
      });
      rejected++;
      await Promise.all([first, second]);
      accepted += 2;
      await sample();
      assert.deepEqual(await readdir(root), []);
    }
    for (let round = 0; round < 5; round++) {
      const validator = createBudgetPdfValidationService({
        temporaryRoot: root,
        limits: { timeoutMs: 1 },
      });
      await assert.rejects(validator.validate(bytes), {
        code: 'validatorTimeout',
      });
      timeouts++;
      assert.deepEqual(await readdir(root), []);
    }
    const uploads = await Promise.all([
      f.intent({ bytes }),
      f.intent({ bytes }),
    ]);
    await Promise.all(
      uploads.map((item) => f.storage.upload(item.proof, item.token)),
    );
    for (const item of uploads) {
      assert.equal(
        Number((await f.storage.stat(item.proof)).size),
        bytes.length,
      );
      await f.orphan(item);
      await f.worker.processClaim(await f.claim(item));
    }
    await createBudgetPdfValidationService({ temporaryRoot: root }).validate(
      bytes,
    );
    await sample();
    clearInterval(timer);
    while (sampling) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      (
        await readFile(`/proc/self/task/${process.pid}/children`, 'utf8')
      ).trim(),
      '',
    );
    assert.deepEqual(await readdir(root), []);
    assert.ok(peakMemory > 0 && peakMemory < 536870912);
    assert.ok(peakChildren <= 2);
    assert.ok(peakTempBytes <= 64 * 1024 * 1024);
    console.log(
      JSON.stringify({
        resourceMetrics: {
          durationMs: Math.round(performance.now() - start),
          peakCgroupMemoryBytes: peakMemory,
          cgroupMemoryPeakBytes: Number(
            await readFile('/sys/fs/cgroup/memory.peak', 'utf8'),
          ),
          peakObservedQpdfChildren: peakChildren,
          peakObservedQpdfRssBytes: peakQpdfRss,
          peakObservedPrivateTempBytes: peakTempBytes,
          acceptedValidations: accepted,
          concurrencyRejections: rejected,
          controlledTimeouts: timeouts,
          concurrentUploads: 2,
          orphanChildren: 0,
          remainingTemporaryFiles: 0,
        },
      }),
    );
  } finally {
    clearInterval(timer);
    await rm(root, { recursive: true, force: true });
    await f.db.close();
  }
});
