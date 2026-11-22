import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupAlertCodes } from '../../../src/app/services/BudgetPdfCleanupWorker.js';

test('T061 cleanup alert thresholds are strict, sanitized and independent', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  assert.deepEqual(cleanupAlertCodes({}, now), []);
  assert.deepEqual(
    cleanupAlertCodes(
      { oldestPendingAt: new Date(now - 3600000), maxAttempts: 9 },
      now,
    ),
    [],
  );
  assert.deepEqual(
    cleanupAlertCodes(
      { oldestPendingAt: new Date(now - 3600001), maxAttempts: 10 },
      now,
    ),
    ['budgetCleanupBacklogOverOneHour', 'budgetCleanupTenErrors'],
  );
  assert.deepEqual(cleanupAlertCodes({ maxAttempts: 10 }, now), [
    'budgetCleanupTenErrors',
  ]);
});
