import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  matrixFixture,
  waitForLock,
} from '../../support/budgets/matrix-fixture.js';
import { BudgetPermissionService } from '../../../src/app/services/BudgetPermissionService.js';
import { BudgetPdfReplacementService } from '../../../src/app/services/BudgetPdfReplacementService.js';
import { BudgetPdfStreamService } from '../../../src/app/services/BudgetPdfStreamService.js';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';
import { Writable } from 'node:stream';
import { budgetEtag } from '../../../src/app/services/BudgetContractService.js';

test('T058 real PG17 revocation serializes reads and upload attach after storage PUT', async (t) => {
  const f = await matrixFixture();
  t.after(() => f.db.close());
  const sector = f.sectorId,
    actorId = await f.user();
  await f.rows(
    'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:id,:sector,:admin,now())',
    { id: actorId, sector, admin: f.creator },
  );
  const permissions = new BudgetPermissionService({
    repository: f.authRepository,
    authorization: f.authorization,
    objects: f.objects,
  });
  const admin = { id: f.creator, type: 'user' },
    actor = { id: actorId, type: 'user' };
  for (const op of ['READ', 'REPLACE_PDF'])
    await permissions.change(sector, actorId, 'GRANT', op, admin);
  const item = await f.attached();
  const owner = item.proof.owner_budget_id;
  const stream = new BudgetPdfStreamService({
    budgets: f.budgets,
    objects: f.objects,
    authorization: f.authorization,
    storage: f.storage,
  });
  await t.test(
    'stream holds authorization guard; revoke waits; later request denied',
    async () => {
      let ready, release;
      const entered = new Promise((resolve) => {
        ready = resolve;
      });
      const paused = new Promise((resolve) => {
        release = resolve;
      });
      let bytes = 0;
      const receiver = new Writable({
        write(chunk, _enc, cb) {
          bytes += chunk.length;
          cb();
        },
      });
      const delivery = stream.stream(
        { id: owner, actor, slot: 'pending' },
        receiver,
        {
          onReady: async () => {
            ready();
            await paused;
          },
        },
      );
      const contender = await f.db.transaction();
      try {
        await entered;
        const [{ pid }] = await f.rows(
          'SELECT pg_backend_pid() AS pid',
          {},
          contender,
        );
        const revoke = (async () => {
          await f.authorization.authorizePermissionChange(
            {
              actorId: f.creator,
              targetUserId: actorId,
              sectorId: sector,
              action: 'REVOKE',
              operation: 'READ',
            },
            contender,
          );
          await f.authRepository.revoke(actorId, sector, 'READ', contender);
          await contender.commit();
        })();
        await waitForLock(f.rows, pid);
        assert.equal(
          (
            await f.rows(
              "SELECT operation FROM public.budget_commercial_permissions WHERE user_id=:id AND sector_id=:sector AND operation='READ'",
              { id: actorId, sector },
            )
          ).length,
          1,
        );
        release();
        await delivery;
        assert.ok(bytes > 0);
        await revoke;
        await assert.rejects(
          f.tx((current) =>
            f.authorization.authorizeOperation(
              { actorId, sectorId: sector, operation: 'READ' },
              current,
            ),
          ),
          { code: 'forbidden' },
        );
      } finally {
        release();
        if (!contender.finished) await contender.rollback();
        receiver.destroy();
      }
    },
  );
  await t.test(
    'revocation during actual upload cannot attach a new candidate',
    async () => {
      const revision = String((await f.Budget.findByPk(owner)).revision);
      const adapter = Object.create(f.storage);
      let reached;
      const gate = new Promise((resolve) => {
        reached = resolve;
      });
      let release;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      adapter.upload = async (...args) => {
        const uploaded = await f.storage.upload(...args);
        reached();
        await wait;
        return uploaded;
      };
      const replacement = new BudgetPdfReplacementService({
        budgets: f.budgets,
        objects: f.objects,
        authorization: f.authorization,
        storage: adapter,
      });
      const work = replacement.replace(
        owner,
        {},
        actor,
        buildPdf({ size: 2048 }),
        { ifMatch: budgetEtag(owner, revision) },
      );
      const rejected = assert.rejects(work, { code: 'forbidden' });
      try {
        await gate;
        await permissions.change(
          sector,
          actorId,
          'REVOKE',
          'REPLACE_PDF',
          admin,
        );
      } finally {
        release();
      }
      await rejected;
      const budget = await f.Budget.findByPk(owner);
      assert.equal(budget.pending_object_id, item.proof.id);
      assert.equal(String(budget.revision), revision);
      const rows = await f.rows(
        'SELECT state FROM public.budget_pdf_objects WHERE owner_budget_id=:owner AND id<>:old',
        { owner, old: item.proof.id },
      );
      assert.ok(rows.length > 0);
      assert.ok(
        rows.every(
          (x) => x.state === 'CLEANUP_PENDING' || x.state === 'REMOVED',
        ),
      );
      // Real worker processes the orphan without deleting the protected slot.
      for (const job of await f.tx((tx) => f.objects.claimCleanup(tx)))
        if (job.owner_budget_id === owner) await f.worker.processClaim(job);
      assert.ok(await f.storage.stat(item.proof));
    },
  );
});
