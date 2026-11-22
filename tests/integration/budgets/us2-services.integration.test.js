import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { matrixFixture } from '../../support/budgets/matrix-fixture.js';
import { BudgetPdfPublishService } from '../../../src/app/services/BudgetPdfPublishService.js';
import { ClientBudgetPdfService } from '../../../src/app/services/ClientBudgetPdfService.js';
import { budgetEtag } from '../../../src/app/services/BudgetContractService.js';

test('T034/T035 services only: PG17/MinIO manual publication and owner portal (NOT HTTP/stream)', async (t) => {
  const f = await matrixFixture();
  const deps = {
    budgets: f.budgets,
    objects: f.objects,
    authorization: f.authorization,
    storage: f.storage,
  };
  const publish = new BudgetPdfPublishService(deps);
  const portal = new ClientBudgetPdfService({
    ...deps,
    cursorSecret: 'isolated-us2-service-cursor-secret-32-bytes',
    now: () => new Date('2030-01-01T03:00:00Z'),
  });
  const admin = { id: f.creator, type: 'user' },
    client = { id: f.clientId, type: 'client' };
  const call = (item, actor = admin, rev = '1', service = publish) =>
    service.publish(
      item.proof.owner_budget_id,
      { pendingDocumentId: item.proof.id },
      actor,
      { ifMatch: budgetEtag(item.proof.owner_budget_id, rev) },
    );
  async function grant(user, sector, operation) {
    await f.rows(
      'INSERT INTO public.budget_commercial_permissions(user_id,sector_id,operation,granted_by) VALUES (:user,:sector,:operation,:admin)',
      { user, sector, operation, admin: f.creator },
    );
  }
  async function member(user, sector) {
    await f.rows(
      'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:user,:sector,:admin,now())',
      { user, sector, admin: f.creator },
    );
  }
  async function attached(options) {
    const item = await f.attached(options);
    // Foundation helper retains upload lease on ATTACHED; real create service
    // clears it. Model the production-ready candidate without changing G1.
    await f.rows(
      'UPDATE public.budget_pdf_objects SET lease_token=NULL,lease_until=NULL WHERE id=:id',
      { id: item.proof.id },
    );
    return item;
  }
  try {
    await t.test(
      'PUBLISH without READ; owner sees expired metadata, foreign/private absent; client cursor scoped',
      async () => {
        const actor = { id: await f.user(), type: 'user' };
        await member(actor.id, f.sectorId);
        await grant(actor.id, f.sectorId, 'PUBLISH');
        const privateItem = await attached();
        await assert.rejects(
          portal.detail(privateItem.proof.owner_budget_id, client),
          { code: 'notFound' },
        );
        for (let i = 0; i < 3; i++) {
          const item = await attached();
          assert.deepEqual(await call(item, actor), {
            id: item.proof.owner_budget_id,
            revision: '2',
          });
          const stored = await f.Budget.findByPk(item.proof.owner_budget_id);
          assert.equal(stored.pending_object_id, null);
          assert.equal(stored.published_object_id, item.proof.id);
          assert.equal(stored.published_validity_date, item.date);
          assert.ok(stored.first_published_at);
          const dto = await portal.detail(stored.id, client);
          assert.equal(dto.expired, true);
          assert.equal(dto.sector.id, f.sectorId);
          assert.equal(typeof dto.sector.name, 'string');
          assert.deepEqual(Object.keys(dto).sort(), [
            'administrativeName',
            'commercialNumber',
            'expired',
            'id',
            'sector',
            'validityDate',
          ]);
          await assert.rejects(
            portal.detail(stored.id, { id: await f.client(), type: 'client' }),
            { code: 'notFound' },
          );
        }
        const page = await portal.list({ limit: 1 }, client);
        assert.ok(page.nextCursor);
        const second = await portal.list(
          { limit: 1, cursor: page.nextCursor },
          client,
        );
        assert.notEqual(page.items[0].id, second.items[0].id);
        await assert.rejects(
          portal.list(
            { cursor: page.nextCursor },
            { id: await f.client(), type: 'client' },
          ),
          { code: 'invalidCursor' },
        );
        assert.deepEqual(
          await portal.list({}, { id: await f.client(), type: 'client' }),
          { items: [], nextCursor: null },
        );
      },
    );
    await t.test(
      'no PUBLISH, other sector, membership and permission revoked during stat deny commit',
      async () => {
        const actor = { id: await f.user(), type: 'user' };
        await member(actor.id, f.sectorId);
        await grant(actor.id, f.sectorId, 'CREATE_EDIT');
        const item = await attached();
        await assert.rejects(call(item, actor), { code: 'forbidden' });
        await grant(actor.id, f.sectorId, 'PUBLISH');
        const foreign = await attached({ sector: await f.sector() });
        await assert.rejects(call(foreign, actor), { code: 'forbidden' });
        for (const table of ['budget_commercial_permissions', 'user_sectors']) {
          const changed = new BudgetPdfPublishService({
            ...deps,
            storage: {
              async stat(row) {
                const result = await f.storage.stat(row);
                await f.rows(
                  `DELETE FROM public.${table} WHERE user_id=:id AND sector_id=:sector`,
                  { id: actor.id, sector: f.sectorId },
                );
                return result;
              },
            },
          });
          await assert.rejects(call(item, actor, '1', changed), {
            code: 'forbidden',
          });
          assert.equal(
            (await f.Budget.findByPk(item.proof.owner_budget_id))
              .published_object_id,
            null,
          );
          if (table === 'budget_commercial_permissions')
            await grant(actor.id, f.sectorId, 'PUBLISH');
        }
      },
    );
    await t.test(
      'sector manager may publish only within membership; published identity frozen by PG guards',
      async () => {
        const manager = { id: await f.user(), type: 'user' };
        await member(manager.id, f.sectorId);
        await f.rows(
          'INSERT INTO public.budget_commercial_managers(user_id,sector_id,appointed_by) VALUES (:user,:sector,:admin)',
          { user: manager.id, sector: f.sectorId, admin: f.creator },
        );
        const item = await attached();
        await call(item, manager);
        const id = item.proof.owner_budget_id;
        for (const field of ['client_id', 'sector_id', 'commercial_number']) {
          await assert.rejects(
            f.tx(async (tx) => {
              await f.budgets.lockBudget(id, tx);
              await f.budgets.compareAndSwap(
                id,
                '2',
                {
                  [field]:
                    field === 'commercial_number' ? 'changed' : randomUUID(),
                },
                tx,
              );
            }),
            (error) => error.original?.code === '23514',
          );
        }
        const foreign = await attached({ sector: await f.sector() });
        await assert.rejects(call(foreign, manager), { code: 'forbidden' });
        // Admin global requires neither membership nor grant in this sector.
        assert.equal((await call(foreign)).revision, '2');
      },
    );
    await t.test(
      'concurrent publishers one winner, stale412, noPending409; client cannot publish',
      async () => {
        const item = await attached();
        const results = await Promise.allSettled([call(item), call(item)]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(
          results.find((r) => r.status === 'rejected').reason.code,
          'revisionMismatch',
        );
        await assert.rejects(call(item), { code: 'revisionMismatch' });
        await assert.rejects(call(item, admin, '2'), { code: 'noPendingPdf' });
        await assert.rejects(call(item, client, '2'), { code: 'forbidden' });
      },
    );
    await t.test(
      'missing real object503; rollback preserves private pair; confirmed candidate required',
      async () => {
        const item = await attached();
        const broken = new BudgetPdfPublishService({
          ...deps,
          storage: {
            stat: () =>
              f.storage.stat({
                ...item.proof,
                object_key: `budgets-pdf/${item.proof.owner_budget_id}/${randomUUID()}.pdf`,
              }),
          },
        });
        await assert.rejects(call(item, admin, '1', broken), {
          code: 'storageUnavailable',
        });
        const badCandidate = new BudgetPdfPublishService({
          ...deps,
          objects: new Proxy(f.objects, {
            get(target, key) {
              if (key === 'lockObjects')
                return async (...args) =>
                  (await target.lockObjects(...args)).map((row) => ({
                    ...row.toJSON(),
                    state: 'UPLOADING',
                  }));
              return typeof target[key] === 'function'
                ? target[key].bind(target)
                : target[key];
            },
          }),
        });
        await assert.rejects(call(item, admin, '1', badCandidate), {
          code: 'storageUnavailable',
        });
        const failAfterCas = new BudgetPdfPublishService({
          ...deps,
          budgets: new Proxy(f.budgets, {
            get(target, key) {
              if (key === 'compareAndSwap')
                return async (...args) => {
                  await target.compareAndSwap(...args);
                  throw new Error('commit rejected');
                };
              return typeof target[key] === 'function'
                ? target[key].bind(target)
                : target[key];
            },
          }),
        });
        await assert.rejects(call(item, admin, '1', failAfterCas), {
          code: 'storageUnavailable',
        });
        const row = await f.Budget.findByPk(item.proof.owner_budget_id);
        assert.equal(row.pending_object_id, item.proof.id);
        assert.equal(row.published_object_id, null);
        assert.equal(row.revision, '1');
      },
    );
    await t.test(
      'prior publication cleanup atomic; first milestone immutable; no physical deletion',
      async () => {
        const old = await attached();
        await call(old);
        const first = (await f.Budget.findByPk(old.proof.owner_budget_id))
          .first_published_at;
        // Foundation fixture only, NOT a replacement service/endpoint (US3).
        const next = await f.intent({
          owner: old.proof.owner_budget_id,
          revision: '2',
          date: '2028-12-31',
        });
        await f.storage.upload(next.proof, next.token);
        await f.tx(async (tx) => {
          await f.budgets.lockBudget(old.proof.owner_budget_id, tx);
          await f.objects.lockObjects([next.proof.id], tx);
          await f.ready(next, tx);
          await f.budgets.compareAndSwap(
            old.proof.owner_budget_id,
            '2',
            {
              pending_object_id: next.proof.id,
              pending_validity_date: next.date,
            },
            tx,
          );
          await f.rows(
            "UPDATE public.budget_pdf_objects SET state='ATTACHED',lease_token=NULL,lease_until=NULL WHERE id=:id",
            { id: next.proof.id },
            tx,
          );
        });
        const broken = new BudgetPdfPublishService({
          ...deps,
          objects: new Proxy(f.objects, {
            get(target, key) {
              if (key === 'enqueueDetached')
                return async (...args) => {
                  await target.enqueueDetached(...args);
                  throw new Error('rollback');
                };
              return typeof target[key] === 'function'
                ? target[key].bind(target)
                : target[key];
            },
          }),
        });
        await assert.rejects(call(next, admin, '3', broken), {
          code: 'storageUnavailable',
        });
        assert.equal(
          (await f.Budget.findByPk(old.proof.owner_budget_id))
            .published_object_id,
          old.proof.id,
        );
        assert.equal(
          (await f.ObjectModel.findByPk(old.proof.id)).state,
          'ATTACHED',
        );
        await call(next, admin, '3');
        const row = await f.Budget.findByPk(old.proof.owner_budget_id);
        assert.equal(row.published_object_id, next.proof.id);
        assert.equal(row.published_validity_date, next.date);
        assert.equal(row.first_published_at.toISOString(), first.toISOString());
        assert.equal(
          (await f.ObjectModel.findByPk(old.proof.id)).state,
          'CLEANUP_PENDING',
        );
        assert.ok(await f.storage.stat(old.proof));
        assert.ok(await f.storage.stat(next.proof));
      },
    );
  } finally {
    await f.db.close();
  }
});
