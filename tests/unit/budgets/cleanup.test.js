import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBudgetPdfCleanupWorker,
  cleanupRetryMs,
} from '../../../src/app/services/BudgetPdfCleanupWorker.js';

// Unit-only model of durable state/transaction rollback. Not PostgreSQL evidence.
function setup() {
  let now = 1000000;
  const row = {
    id: '12345678-1234-4234-8234-123456789abc',
    owner_budget_id: '12345678-1234-4234-8234-123456789abc',
    state: 'CLEANUP_PENDING',
    lease_token: null,
    lease_until: null,
    attempts: 0,
    next_attempt_at: 0,
  };
  let referenced = false;
  let present = true;
  let failDelete = false;
  let failFinish = false;
  let deletes = 0;
  let claimNumber = 0;
  const events = [];
  const repository = {
    transaction: async (fn) => {
      const snapshot = { ...row };
      try {
        return await fn({});
      } catch (error) {
        Object.assign(row, snapshot);
        throw error;
      }
    },
    lockOwned: async () => {
      events.push('lock');
      return row;
    },
    leaseIsCurrent: async (_, token) =>
      row.state === 'CLEANING' &&
      token === row.lease_token &&
      Number(row.lease_until) > now,
    referencesObject: async () => {
      events.push('references');
      return referenced;
    },
    claimCleanup: async () => {
      if (
        referenced ||
        !(
          (row.state === 'CLEANUP_PENDING' &&
            Number(row.next_attempt_at) <= now) ||
          (row.state === 'CLEANING' && Number(row.lease_until) <= now)
        )
      )
        return [];
      Object.assign(row, {
        state: 'CLEANING',
        lease_token: `token-${++claimNumber}`,
        lease_until: new Date(now + 120000),
        attempts: row.attempts + 1,
      });
      return [{ ...row }];
    },
    compareAndSwapLease: async ({ token, state, nextState, values }) => {
      if (
        token !== row.lease_token ||
        row.state !== state ||
        Number(row.lease_until) <= now
      )
        throw new Error('budgetLeaseLost');
      if (nextState === 'REMOVED' && failFinish)
        throw new Error('interruption');
      Object.assign(row, { state: nextState, ...values });
      return row;
    },
    reconcileCandidates: async () =>
      row.state === 'REMOVED' ||
      (row.state === 'UPLOADING' && Number(row.lease_until) <= now)
        ? [{ ...row }]
        : [],
    enqueueUnreferenced: async () => {
      if (referenced) return false;
      Object.assign(row, {
        state: 'CLEANUP_PENDING',
        lease_token: null,
        lease_until: null,
        next_attempt_at: now,
        removed_at: null,
      });
      return true;
    },
    registerUnknown: async () => {
      events.push('register');
    },
  };
  const storage = {
    bucket: 'private-pdfs',
    remove: async () => {
      events.push('remove');
      deletes++;
      if (failDelete) throw new Error('network');
      present = false;
    },
    stat: async () => (present ? { size: 1 } : null),
    listPage: async (options) => {
      assert.ok(!options.after || options.after.startsWith('budgets-pdf/'));
      return { entries: [], next: '' };
    },
  };
  const options = { repository, storage, now: () => now, random: () => 0 };
  return {
    row,
    repository,
    storage,
    options,
    events,
    worker: createBudgetPdfCleanupWorker(options),
    advance: (ms) => {
      now += ms;
    },
    referenced: (value) => {
      referenced = value;
    },
    present: (value) => {
      present = value;
    },
    failDelete: (value) => {
      failDelete = value;
    },
    failFinish: (value) => {
      failFinish = value;
    },
    deletes: () => deletes,
  };
}
test('T019 durable claim before delete, idempotent absence and repeated ticks', async () => {
  const s = setup();
  s.present(false);
  assert.deepEqual((await s.worker.tick()).results, ['removed']);
  assert.equal(s.row.state, 'REMOVED');
  assert.ok(s.events.indexOf('references') < s.events.indexOf('remove'));
  assert.deepEqual((await s.worker.tick()).results, []);
  assert.equal(s.deletes(), 1);
});
test('T019 both pending/published reference outcomes protect malformed claims', async () => {
  for (const slot of ['pending_object_id', 'published_object_id']) {
    const s = setup();
    const [claim] = await s.repository.claimCleanup();
    s.referenced(slot);
    assert.equal(await s.worker.processClaim(claim), 'referenced');
    assert.equal(s.deletes(), 0);
  }
});
test('T019 two instances and expired tokens fenced before I/O', async () => {
  const s = setup();
  const first = createBudgetPdfCleanupWorker(s.options);
  const second = createBudgetPdfCleanupWorker(s.options);
  const [old] = await s.repository.claimCleanup();
  assert.equal((await s.repository.claimCleanup()).length, 0);
  s.advance(120001);
  assert.equal(await first.processClaim(old), 'stale');
  const [fresh] = await s.repository.claimCleanup();
  assert.notEqual(old.lease_token, fresh.lease_token);
  assert.equal(await first.processClaim(old), 'stale');
  assert.equal(await second.processClaim(fresh), 'removed');
  assert.equal(await first.processClaim(old), 'stale');
  assert.equal(s.deletes(), 1);
});
test('T019 storage retry with exponential backoff and jitter', async () => {
  const s = setup();
  s.failDelete(true);
  assert.deepEqual((await s.worker.tick()).results, ['retry']);
  assert.equal(s.row.state, 'CLEANUP_PENDING');
  assert.equal(s.row.last_error_code, 'storageUnavailable');
  assert.deepEqual((await s.worker.tick()).results, []);
  s.advance(5000);
  s.failDelete(false);
  assert.deepEqual((await s.worker.tick()).results, ['removed']);
  assert.equal(s.row.attempts, 2);
  assert.equal(
    cleanupRetryMs(1, () => 0),
    5000,
  );
  assert.equal(
    cleanupRetryMs(2, () => 0),
    10000,
  );
  assert.equal(
    cleanupRetryMs(500, () => 0.999),
    3600999,
  );
});
test('T019 interrupted after external delete recovers after restart using durable claim', async () => {
  const s = setup();
  s.failFinish(true);
  assert.deepEqual((await s.worker.tick()).results, ['recoveryPending']);
  assert.equal(s.row.state, 'CLEANING');
  s.advance(120001);
  s.failFinish(false);
  const restarted = createBudgetPdfCleanupWorker(s.options);
  assert.deepEqual((await restarted.tick()).results, ['removed']);
  assert.equal(s.deletes(), 2);
});
test('T019 expired intent invalidated; late PUT after REMOVED is removed again, never attached', async () => {
  const s = setup();
  Object.assign(s.row, {
    state: 'UPLOADING',
    lease_token: 'uploader',
    lease_until: new Date(0),
  });
  assert.deepEqual((await s.worker.tick()).results, ['removed']);
  s.present(true);
  const restarted = createBudgetPdfCleanupWorker(s.options);
  assert.deepEqual((await restarted.tick()).results, ['removed']);
  assert.equal(s.deletes(), 2);
  assert.equal(s.row.state, 'REMOVED');
  assert.notEqual(s.row.lease_token, 'uploader');
});
test('T019 active uploads/attached documents are not reconciled as orphans', async () => {
  for (const state of ['UPLOADING', 'ATTACHED']) {
    const s = setup();
    Object.assign(s.row, { state, lease_until: new Date(9999999) });
    await s.worker.tick();
    assert.equal(s.deletes(), 0);
    assert.equal(s.row.state, state);
  }
});
test('T019 prefix reconciliation: 24h grace, technical actor required, no bucket-wide delete', async () => {
  const s = setup();
  s.repository.lockOwned = async () => null;
  let unknownReferences = false;
  s.repository.referencesObject = async () => unknownReferences;
  let age = 0;
  s.storage.listPage = async () => ({
    entries: [
      {
        name: `budgets-pdf/${s.row.owner_budget_id}/${s.row.id}.pdf`,
        lastModified: new Date(1000000 - age),
      },
    ],
    next: '',
  });
  const worker = createBudgetPdfCleanupWorker({
    ...s.options,
    reconcilerActorId: s.row.id,
  });
  await worker.reconcilePrefix();
  assert.ok(!s.events.includes('register'));
  age = 86400000;
  unknownReferences = true;
  await worker.reconcilePrefix();
  assert.ok(!s.events.includes('register'));
  unknownReferences = false;
  await worker.reconcilePrefix();
  assert.ok(s.events.includes('register'));
  assert.equal(s.deletes(), 0); // registration only; separate durable claim/delete
  s.events.length = 0;
  await s.worker.reconcilePrefix();
  assert.ok(!s.events.includes('register'));
});
test('T019 reentrant tick is bounded and uses no second claim', async () => {
  const s = setup();
  let release;
  s.repository.reconcileCandidates = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const first = s.worker.tick();
  await Promise.resolve();
  assert.deepEqual(await s.worker.tick(), { busy: true });
  release([]);
  await first;
  assert.equal(s.deletes(), 1);
});
