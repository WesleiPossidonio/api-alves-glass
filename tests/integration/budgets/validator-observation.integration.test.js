import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { matrixFixture } from '../../support/budgets/matrix-fixture.js';
import { createBudgetPdfValidationService } from '../../../src/app/services/BudgetPdfValidationService.js';
import { linuxRssBytes } from '../../../src/app/services/BudgetPdfValidationService.js';
import { createBudgetPdfRuntimeService } from '../../../src/app/services/BudgetPdfRuntimeService.js';
import { BudgetPdfStorageServiceClient } from '../../../src/app/services/BudgetPdfStorageService.js';
import { BudgetPdfCreateService } from '../../../src/app/services/BudgetPdfCreateService.js';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';
import { randomUUID } from 'node:crypto';

test('bounded validatorFailed investigation: real qpdf processes, cold runtime and concurrent creates', async () => {
  const f = await matrixFixture();
  const events = [];
  let peak = 0,
    running = 0;
  // Only sanitized operational facts, never qpdf output, bytes, keys or secrets.
  const observedSpawn = (executable, args, options) => {
    const child = spawn(executable, args, options);
    running++;
    peak = Math.max(peak, running);
    child.on('error', (error) =>
      events.push({
        event: 'spawnError',
        code: ['ENOENT', 'EACCES'].includes(error.code) ? error.code : 'other',
      }),
    );
    child.on('close', (code, signal) => {
      running--;
      events.push({ event: 'close', phase: args[0], code, signal });
    });
    const kill = child.kill.bind(child);
    child.kill = (signal) => {
      events.push({ event: 'kill', signal });
      return kill(signal);
    };
    return child;
  };
  const rss = async (pid) => {
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (match) return Number(match[1]) * 1024;
      if (/^State:\s+Z\b/m.test(status)) return 0;
      events.push({
        event: 'rssMissing',
        state: status.match(/^State:\s+(\w)/m)?.[1] ?? 'unknown',
      });
      return linuxRssBytes(pid);
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) {
        try {
          process.kill(pid, 0);
        } catch (probe) {
          if (probe.code === 'ESRCH') return 0;
        }
      }
      events.push({ event: 'rssReadError', code: error.code });
      throw error;
    }
  };
  try {
    for (let round = 0; round < 20; round++) {
      const validator = createBudgetPdfValidationService({
        spawn: observedSpawn,
        readRssBytes: rss,
      });
      const runtime = createBudgetPdfRuntimeService({ validator });
      const storage = new BudgetPdfStorageServiceClient({
        repository: f.objects,
        validator,
        runtime,
      });
      const service = new BudgetPdfCreateService({
        budgets: f.budgets,
        objects: f.objects,
        authorization: f.authorization,
        storage,
      });
      const results = await Promise.allSettled(
        [0, 1].map(() =>
          service.create(
            {
              sectorId: f.sectorId,
              clientId: f.clientId,
              commercialNumber: randomUUID(),
              administrativeName: 'validator observation',
              validityDate: '2027-01-01',
            },
            { id: f.creator, type: 'user' },
            buildPdf({ size: 10 * 1024 * 1024 }),
          ),
        ),
      );
      const codes = results.map((result) =>
        result.status === 'fulfilled' ? 'created' : result.reason.code,
      );
      console.log(
        JSON.stringify({
          validatorRound: round,
          codes,
          events: events.splice(0),
        }),
      );
      assert.deepEqual(codes, ['created', 'created']);
    }
    assert.equal(running, 0);
    assert.ok(peak <= 2);
    console.log(
      JSON.stringify({
        validatorObservation: {
          rounds: 20,
          concurrent: 2,
          created: 40,
          peakChildren: peak,
          orphans: running,
        },
      }),
    );
  } finally {
    await f.db.close();
  }
});
