import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import objects from '../repositories/BudgetPdfObjectRepository.js';
import {
  BudgetPdfStorageServiceClient,
  parseBudgetObjectKey,
} from './BudgetPdfStorageService.js';
import { uuid } from './BudgetContractService.js';

export function cleanupRetryMs(attempts, random = Math.random) {
  return (
    Math.min(3600000, 5000 * 2 ** Math.min(20, Math.max(0, attempts - 1))) +
    Math.floor(random() * 1000)
  );
}
export function cleanupAlertCodes(
  { oldestPendingAt, maxAttempts },
  now = Date.now(),
) {
  const codes = [];
  if (oldestPendingAt && now - new Date(oldestPendingAt).getTime() > 3600000)
    codes.push('budgetCleanupBacklogOverOneHour');
  if (Number(maxAttempts) >= 10) codes.push('budgetCleanupTenErrors');
  return codes;
}
export function createBudgetPdfCleanupWorker({
  repository = objects,
  storage = new BudgetPdfStorageServiceClient(),
  now = Date.now,
  random = Math.random,
  reconcilerActorId,
  alert = () => {},
} = {}) {
  if (reconcilerActorId) uuid(reconcilerActorId);
  let registryAfter = '';
  let storageAfter = '';
  let lastScan = -Infinity;
  let running = false;
  const tx = (callback) => repository.transaction(callback);

  async function processClaim(claim, signal) {
    return tx(async (transaction) => {
      const row = await repository.lockOwned(claim, transaction);
      if (
        !row ||
        !(await repository.leaseIsCurrent(row, claim.lease_token, transaction))
      )
        return 'stale';
      if (await repository.referencesObject(row.id, transaction)) {
        alert('budgetCleanupReferenced');
        return 'referenced';
      }
      const common = {
        id: row.id,
        token: claim.lease_token,
        state: 'CLEANING',
      };
      // Dedicated cleanup lock held across at most 2 x 30s I/O, below the renewed
      // 2-minute lease. No other worker can steal the row during this delete.
      await repository.compareAndSwapLease(
        {
          ...common,
          nextState: 'CLEANING',
          values: { lease_until: new Date(now() + 120000) },
        },
        transaction,
      );
      try {
        await storage.remove(row, { signal });
      } catch {
        await repository.compareAndSwapLease(
          {
            ...common,
            nextState: 'CLEANUP_PENDING',
            values: {
              lease_token: null,
              lease_until: null,
              last_error_code: 'storageUnavailable',
              next_attempt_at: new Date(
                now() + cleanupRetryMs(row.attempts, random),
              ),
            },
          },
          transaction,
        );
        return 'retry';
      }
      // If this transaction/commit fails after external deletion, its committed
      // claim remains CLEANING: the next lease holder repeats delete/stat safely.
      await repository.compareAndSwapLease(
        {
          ...common,
          nextState: 'REMOVED',
          values: {
            lease_token: null,
            lease_until: null,
            removed_at: new Date(now()),
            last_error_code: null,
          },
        },
        transaction,
      );
      return 'removed';
    });
  }
  async function reconcileRegistry(signal) {
    const candidates = await tx((transaction) =>
      repository.reconcileCandidates(transaction, {
        after: registryAfter,
        limit: 25,
      }),
    );
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      await tx(async (transaction) => {
        const row = await repository.lockOwned(candidate, transaction);
        if (!row || (await repository.referencesObject(row.id, transaction)))
          return;
        // Keep terminal records forever: a remote PUT may finish after timeout.
        if (row.state === 'REMOVED' && !(await storage.stat(row, { signal })))
          return;
        await repository.enqueueUnreferenced(row, transaction);
      });
      registryAfter = candidate.id;
    }
    if (candidates.length < 25) registryAfter = '';
  }
  async function reconcilePrefix(signal) {
    const page = await storage.listPage({
      after: storageAfter,
      limit: 25,
      signal,
    });
    for (const item of page.entries) {
      let identity;
      try {
        identity = parseBudgetObjectKey(item.name);
      } catch {
        alert('budgetUnknownKeyFormat');
        continue;
      }
      const modified = new Date(item.lastModified).getTime();
      if (!Number.isFinite(modified) || modified > now() - 86400000) continue;
      await tx(async (transaction) => {
        const row = await repository.lockOwned(identity, transaction);
        if (row) return; // Registry sweep handles known keys, including late PUT.
        if (await repository.referencesObject(identity.id, transaction)) return;
        if (!reconcilerActorId) {
          alert('budgetUnknownObjectNeedsTechnicalActor');
          return;
        }
        await repository.registerUnknown(
          { ...identity, bucket: storage.bucket, object_key: item.name },
          reconcilerActorId,
          transaction,
        );
      });
    }
    storageAfter = page.next;
    if (!storageAfter) lastScan = now();
  }
  async function tick({ signal } = {}) {
    if (running) return { busy: true };
    running = true;
    const results = [];
    try {
      await reconcileRegistry(signal);
      if (storageAfter || now() - lastScan >= 86400000)
        await reconcilePrefix(signal);
      const claims = await tx((transaction) =>
        repository.claimCleanup(transaction, { limit: 25 }),
      );
      for (const claim of claims) {
        if (signal?.aborted) break;
        try {
          results.push(await processClaim(claim, signal));
        } catch {
          alert('budgetCleanupRecoveryPending');
          results.push('recoveryPending');
        }
      }
      return { results };
    } finally {
      running = false;
    }
  }
  return {
    tick,
    processClaim,
    reconcileRegistry,
    reconcilePrefix,
    async run({ signal } = {}) {
      while (!signal?.aborted) {
        try {
          await tick({ signal });
        } catch {
          alert('budgetCleanupUnavailable');
        }
        try {
          await sleep(5000, undefined, { signal });
        } catch {
          break;
        }
      }
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { runWorkerCli } = await import(
    '../../../tests/support/budgets/worker-cli.js'
  );
  process.exitCode = await runWorkerCli(
    process.env,
    createBudgetPdfCleanupWorker,
    cleanupAlertCodes,
  );
}
