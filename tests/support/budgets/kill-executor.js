import { matrixFixture } from './matrix-fixture.js';
import { createBudgetPdfCleanupWorker } from '../../../src/app/services/BudgetPdfCleanupWorker.js';

// Exclusive child, killed by parent only after durable claim + real external
// DELETE/stat. Its DB transaction has not recorded REMOVED yet.
const f = await matrixFixture();
const job = JSON.parse(process.env.BUDGETS_KILL_CLAIM);
const storage = new Proxy(f.storage, {
  get(target, key) {
    if (key === 'remove')
      return async (...args) => {
        await target.remove(...args);
        process.send({
          event: 'externalDeleteConfirmedBeforeDatabaseCAS',
          id: job.id,
        });
        await new Promise(() => {});
      };
    return typeof target[key] === 'function'
      ? target[key].bind(target)
      : target[key];
  },
});
await createBudgetPdfCleanupWorker({
  repository: f.objects,
  storage,
}).processClaim(job);
