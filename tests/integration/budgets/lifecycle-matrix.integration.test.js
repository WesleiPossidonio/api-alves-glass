import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  matrixFixture,
  barrier,
  waitForLock,
} from '../../support/budgets/matrix-fixture.js';
import { createBudgetPdfCleanupWorker } from '../../../src/app/services/BudgetPdfCleanupWorker.js';

test('T022 lifecycle invariants and deterministic real DB/MinIO races', async (t) => {
  const f = await matrixFixture();
  const { rows, tx, budgets, objects, storage, Budget, ObjectModel } = f;
  async function negative(item, assignments) {
    const before = (await Budget.findByPk(item.proof.owner_budget_id)).toJSON();
    await assert.rejects(
      tx(async (transaction) => {
        await rows(
          `UPDATE public.budgets_pdf SET ${assignments},revision=revision+1 WHERE id=:id`,
          { id: item.proof.owner_budget_id, other: randomUUID() },
          transaction,
        );
        await rows('SET CONSTRAINTS ALL IMMEDIATE', {}, transaction);
      }),
      (error) => ['23514', '23503'].includes(error.original?.code),
    );
    assert.deepEqual(
      (await Budget.findByPk(item.proof.owner_budget_id)).toJSON(),
      before,
    );
  }
  async function publish(item, revision, transaction) {
    return budgets.compareAndSwap(
      item.proof.owner_budget_id,
      revision,
      {
        published_object_id: item.proof.id,
        published_validity_date: item.date,
        pending_object_id: null,
        pending_validity_date: null,
        first_published_at: new Date(),
      },
      transaction,
    );
  }
  try {
    await t.test(
      'text uniqueness: same-sector exact duplicate fails; case/zeros/Unicode/other sector distinct',
      async () => {
        const prefix = randomUUID();
        for (const suffix of ['00042', '42', 'Ab', 'ab', 'é', 'e\u0301'])
          await f.attached({ number: prefix + suffix });
        const duplicate = await f.intent();
        await duplicate.adapter.upload(duplicate.proof, duplicate.token);
        await assert.rejects(
          f.attach(duplicate, { number: prefix + '42' }),
          (error) => error.original?.code === '23505',
        );
        assert.equal(
          (await ObjectModel.findByPk(duplicate.proof.id)).state,
          'UPLOADING',
        );
        await f.orphan(duplicate);
        await f.worker.processClaim(await f.claim(duplicate));
        await f.attached({ number: prefix + '42', sector: await f.sector() });
      },
    );
    await t.test(
      'all protected published fields and PDF/date pair atomicity reject and rollback',
      async () => {
        const item = await f.attached();
        await tx((transaction) => publish(item, '1', transaction));
        for (const assignment of [
          'id=:other',
          'created_by=:other',
          "created_at=created_at-interval '1 second'",
          'client_id=:other',
          'sector_id=:other',
          "commercial_number='mutated'",
          'first_published_at=NULL',
          "first_published_at=first_published_at+interval '1 second'",
          'published_object_id=NULL,published_validity_date=NULL',
          "published_validity_date='2028-01-01'",
        ])
          await negative(item, assignment);
        const [row] = await rows(
          'SELECT published_object_id,published_validity_date,revision FROM public.budgets_pdf WHERE id=:id',
          { id: item.proof.owner_budget_id },
        );
        assert.equal(row.published_object_id, item.proof.id);
        assert.equal(row.published_validity_date, '2027-01-01');
        assert.equal(row.revision, '2');
        const candidate = await f.intent({
          owner: item.proof.owner_budget_id,
          revision: '2',
          date: '2028-02-29',
        });
        await candidate.adapter.upload(candidate.proof, candidate.token);
        await tx(async (transaction) => {
          await f.ready(candidate, transaction);
          await budgets.compareAndSwap(
            item.proof.owner_budget_id,
            '2',
            {
              pending_object_id: candidate.proof.id,
              pending_validity_date: candidate.date,
            },
            transaction,
          );
          await rows(
            "UPDATE public.budget_pdf_objects SET state='ATTACHED' WHERE id=:id",
            { id: candidate.proof.id },
            transaction,
          );
        });
        await negative(item, "pending_validity_date='2028-03-01'");
        await tx(async (transaction) => {
          await budgets.lockBudget(item.proof.owner_budget_id, transaction);
          await budgets.compareAndSwap(
            item.proof.owner_budget_id,
            '3',
            {
              published_object_id: candidate.proof.id,
              published_validity_date: candidate.date,
              pending_object_id: null,
              pending_validity_date: null,
            },
            transaction,
          );
          await rows(
            "UPDATE public.budget_pdf_objects SET state='CLEANUP_PENDING',lease_token=NULL,lease_until=NULL WHERE id=:id",
            { id: item.proof.id },
            transaction,
          );
        });
        const [published] = await rows(
          'SELECT published_object_id,published_validity_date FROM public.budgets_pdf WHERE id=:id',
          { id: item.proof.owner_budget_id },
        );
        assert.deepEqual(published, {
          published_object_id: candidate.proof.id,
          published_validity_date: candidate.date,
        });
        await assert.rejects(
          tx((transaction) =>
            budgets.compareAndSwap(
              item.proof.owner_budget_id,
              '3',
              { administrative_name: 'stale' },
              transaction,
            ),
          ),
          { code: 'revisionMismatch' },
        );
      },
    );
    await t.test(
      'registry transition matrix, immutable metadata/identity and no terminal reattach',
      async () => {
        const item = await f.intent();
        await storage.upload(item.proof, item.token);
        for (const state of ['ATTACHED', 'CLEANING', 'REMOVED'])
          await assert.rejects(
            tx((transaction) =>
              rows(
                'UPDATE public.budget_pdf_objects SET state=:state WHERE id=:id',
                { id: item.proof.id, state },
                transaction,
              ),
            ),
            (error) => error.original?.code === '23514',
          );
        await tx((transaction) => f.ready(item, transaction));
        for (const assignment of [
          "sha256=repeat('b',64)",
          'size_bytes=size_bytes+1',
          "content_type='text/plain'",
          "validity_date='2027-02-01'",
          'confirmed_at=NULL',
          'owner_budget_id=:other',
          'created_by=:other',
          'expected_revision=1',
          "bucket='other'",
          "object_key='other'",
          'id=:other',
          "created_at=created_at-interval '1 second'",
        ])
          await assert.rejects(
            tx((transaction) =>
              rows(
                `UPDATE public.budget_pdf_objects SET ${assignment} WHERE id=:id`,
                { id: item.proof.id, other: randomUUID() },
                transaction,
              ),
            ),
            (error) => error.original?.code === '23514',
          );
        await assert.rejects(
          tx((transaction) =>
            rows(
              "UPDATE public.budget_pdf_objects SET state='ATTACHED' WHERE id=:id",
              { id: item.proof.id },
              transaction,
            ),
          ),
          (error) => error.original?.code === '23514',
        );
        await f.orphan(item);
        const job = await f.claim(item);
        await f.worker.processClaim(job);
        await assert.rejects(
          tx((transaction) =>
            rows(
              "UPDATE public.budget_pdf_objects SET state='READY' WHERE id=:id",
              { id: item.proof.id },
              transaction,
            ),
          ),
          (error) => error.original?.code === '23514',
        );
        await assert.rejects(
          tx((transaction) =>
            rows(
              'DELETE FROM public.budget_pdf_objects WHERE id=:id',
              { id: item.proof.id },
              transaction,
            ),
          ),
          (error) => error.original?.code === '23514',
        );
        assert.equal(
          (await ObjectModel.findByPk(item.proof.id)).state,
          'REMOVED',
        );
      },
    );
    await t.test(
      'attach owns lock: cleanup claim cannot steal; committed reference remains private and readable',
      async () => {
        const item = await f.intent();
        await storage.upload(item.proof, item.token);
        const attaching = await f.db.transaction();
        try {
          await f.attach(item, { transaction: attaching });
          const claims = await tx((transaction) =>
            objects.claimCleanup(transaction),
          );
          assert.ok(!claims.some((row) => row.id === item.proof.id));
          await attaching.commit();
          assert.ok(await storage.stat(item.proof));
          assert.equal(
            await tx((transaction) =>
              objects.referencesObject(item.proof.id, transaction),
            ),
            true,
          );
        } finally {
          if (!attaching.finished) await attaching.rollback();
        }
      },
    );
    await t.test(
      'cleanup owns lock first: concurrent attach cannot revive terminal bytes',
      async () => {
        const item = await f.intent();
        await storage.upload(item.proof, item.token);
        await f.orphan(item);
        const job = await f.claim(item);
        const deleting = await f.db.transaction(),
          attaching = await f.db.transaction();
        try {
          const locked = await objects.lockOwned(job, deleting);
          await storage.remove({
            ...locked.toJSON(),
            state: 'CLEANING',
            lease_token: job.lease_token,
          });
          const [{ pid }] = await rows(
            'SELECT pg_backend_pid() AS pid',
            {},
            attaching,
          );
          const attempt = f.attach(item, { transaction: attaching });
          attempt.catch(() => {});
          await waitForLock(rows, pid);
          await objects.compareAndSwapLease(
            {
              id: job.id,
              token: job.lease_token,
              state: 'CLEANING',
              nextState: 'REMOVED',
              values: {
                lease_token: null,
                lease_until: null,
                removed_at: new Date(),
              },
            },
            deleting,
          );
          await deleting.commit();
          await assert.rejects(attempt, { code: 'budgetLeaseLost' });
          await attaching.rollback();
          assert.equal(await Budget.findByPk(item.proof.owner_budget_id), null);
          assert.equal(await storage.stat(item.proof), null);
        } finally {
          if (!deleting.finished) await deleting.rollback();
          if (!attaching.finished) await attaching.rollback();
        }
      },
    );
    await t.test(
      'pending upload loses revision to replacement; old proof cannot overwrite current candidate',
      async () => {
        const original = await f.attached();
        const stale = await f.intent({
            owner: original.proof.owner_budget_id,
            revision: '1',
          }),
          winner = await f.intent({
            owner: original.proof.owner_budget_id,
            revision: '1',
          });
        await Promise.all([
          storage.upload(stale.proof, stale.token),
          storage.upload(winner.proof, winner.token),
        ]);
        await tx(async (transaction) => {
          await f.ready(winner, transaction);
          await budgets.compareAndSwap(
            original.proof.owner_budget_id,
            '1',
            {
              pending_object_id: winner.proof.id,
              pending_validity_date: winner.date,
            },
            transaction,
          );
          await rows(
            "UPDATE public.budget_pdf_objects SET state='ATTACHED' WHERE id=:id",
            { id: winner.proof.id },
            transaction,
          );
          await rows(
            "UPDATE public.budget_pdf_objects SET state='CLEANUP_PENDING',lease_token=NULL,lease_until=NULL WHERE id=:id",
            { id: original.proof.id },
            transaction,
          );
        });
        await assert.rejects(
          tx(async (transaction) => {
            await f.ready(stale, transaction);
            await budgets.compareAndSwap(
              original.proof.owner_budget_id,
              '2',
              {
                pending_object_id: stale.proof.id,
                pending_validity_date: stale.date,
              },
              transaction,
            );
          }),
          (error) => error.original?.code === '23514',
        );
        assert.equal(
          (await Budget.findByPk(original.proof.owner_budget_id))
            .pending_object_id,
          winner.proof.id,
        );
        await f.orphan(stale);
        await f.worker.processClaim(await f.claim(stale));
        assert.ok(await storage.stat(winner.proof));
      },
    );
    await t.test(
      'publication vs cleanup cannot claim referenced pending or delete newly published pair',
      async () => {
        const item = await f.attached();
        const publishing = await f.db.transaction();
        try {
          await budgets.lockBudget(item.proof.owner_budget_id, publishing);
          await publish(item, '1', publishing);
          const claims = await tx((transaction) =>
            objects.claimCleanup(transaction),
          );
          assert.ok(!claims.some((row) => row.id === item.proof.id));
          await publishing.commit();
          assert.ok(await storage.stat(item.proof));
          assert.equal(
            (await Budget.findByPk(item.proof.owner_budget_id))
              .published_object_id,
            item.proof.id,
          );
        } finally {
          if (!publishing.finished) await publishing.rollback();
        }
      },
    );
    await t.test(
      'stream shared guard blocks logical detach and physical deletion until stream finishes',
      async () => {
        const item = await f.attached();
        const reading = await f.db.transaction(),
          deleting = await f.db.transaction();
        let stream;
        try {
          await budgets.lockBudget(item.proof.owner_budget_id, reading, {
            shared: true,
          });
          stream = await storage.get(
            await ObjectModel.findByPk(item.proof.id, { transaction: reading }),
          );
          stream.pause();
          const [{ pid }] = await rows(
            'SELECT pg_backend_pid() AS pid',
            {},
            deleting,
          );
          const detach = f.detach(item, deleting);
          await waitForLock(rows, pid);
          assert.ok(await storage.stat(item.proof));
          for await (const chunk of stream) assert.ok(chunk.length > 0);
          await reading.commit();
          await detach;
          await deleting.commit();
          await f.worker.processClaim(await f.claim(item));
          assert.equal(await storage.stat(item.proof), null);
        } finally {
          stream?.destroy();
          if (!reading.finished) await reading.rollback();
          if (!deleting.finished) await deleting.rollback();
        }
      },
    );
    await t.test(
      'two executors same durable claim: only one real DELETE; stale lease waits and is fenced',
      async () => {
        const item = await f.intent();
        await storage.upload(item.proof, item.token);
        await f.orphan(item);
        const job = await f.claim(item);
        const entered = barrier(),
          release = barrier();
        let deletes = 0;
        // Only barrier around real I/O, no fake successful storage/DB operations.
        const blockedStorage = new Proxy(storage, {
          get(target, key) {
            if (key === 'remove')
              return async (...args) => {
                deletes++;
                entered.release();
                await release.promise;
                return target.remove(...args);
              };
            return typeof target[key] === 'function'
              ? target[key].bind(target)
              : target[key];
          },
        });
        const first = createBudgetPdfCleanupWorker({
          repository: objects,
          storage: blockedStorage,
        }).processClaim(job);
        await entered.promise;
        const second = f.worker.processClaim(job);
        release.release();
        const results = await Promise.all([first, second]);
        assert.deepEqual(results.sort(), ['removed', 'stale']);
        assert.equal(deletes, 1);
        const late = await f.intent();
        await f.orphan(late);
        const expired = await f.claim(late);
        await rows(
          "UPDATE public.budget_pdf_objects SET lease_until=clock_timestamp()-interval '1 second' WHERE id=:id",
          { id: late.proof.id },
        );
        const fresh = await f.claim(late);
        assert.notEqual(expired.lease_token, fresh.lease_token);
        assert.equal(await f.worker.processClaim(expired), 'stale');
        assert.equal(await f.worker.processClaim(fresh), 'removed');
      },
    );
    await t.test(
      'executor still alive with expired in-transaction lease cannot be stolen or finalize; retry recovers real DELETE',
      async () => {
        const item = await f.intent();
        await storage.upload(item.proof, item.token);
        await f.orphan(item);
        const job = await f.claim(item);
        const reached = barrier(),
          release = barrier();
        const repository = new Proxy(objects, {
          get(target, key) {
            if (key === 'transaction')
              return (callback) =>
                target.transaction(async (transaction) => {
                  return callback(transaction);
                });
            if (key === 'compareAndSwapLease')
              return async (input, transaction) => {
                const result = await target.compareAndSwapLease(
                  input,
                  transaction,
                );
                if (input.nextState === 'CLEANING') {
                  await rows(
                    "UPDATE public.budget_pdf_objects SET lease_until=CURRENT_TIMESTAMP-interval '1 second' WHERE id=:id",
                    { id: job.id },
                    transaction,
                  );
                  reached.release();
                  await release.promise;
                }
                return result;
              };
            return typeof target[key] === 'function'
              ? target[key].bind(target)
              : target[key];
          },
        });
        const active = createBudgetPdfCleanupWorker({
          repository,
          storage,
        }).processClaim(job);
        active.catch(() => {});
        await reached.promise;
        const claims = await tx((transaction) =>
          objects.claimCleanup(transaction),
        );
        assert.ok(!claims.some((row) => row.id === job.id));
        release.release();
        await assert.rejects(active, { code: 'budgetLeaseLost' });
        assert.equal(await storage.stat(item.proof), null);
        assert.equal((await ObjectModel.findByPk(job.id)).state, 'CLEANING');
        await rows(
          "UPDATE public.budget_pdf_objects SET lease_until=clock_timestamp()-interval '1 second' WHERE id=:id",
          { id: job.id },
        );
        const replacement = await f.claim(item);
        assert.notEqual(replacement.lease_token, job.lease_token);
        assert.equal(await f.worker.processClaim(job), 'stale');
        assert.equal(await f.worker.processClaim(replacement), 'removed');
      },
    );
    await t.test(
      'cross-owner slot, wrong validity, nonincrementing revision and non-ATTACHED commit all roll back',
      async () => {
        const item = await f.attached(),
          foreign = await f.attached();
        await negative(item, `pending_object_id='${foreign.proof.id}'`);
        const candidate = await f.intent({
          owner: item.proof.owner_budget_id,
          revision: '1',
        });
        await storage.upload(candidate.proof, candidate.token);
        await assert.rejects(
          tx(async (transaction) => {
            await f.ready(candidate, transaction);
            await budgets.compareAndSwap(
              item.proof.owner_budget_id,
              '1',
              {
                pending_object_id: candidate.proof.id,
                pending_validity_date: '2027-02-02',
              },
              transaction,
            );
          }),
          (error) => error.original?.code === '23514',
        );
        await assert.rejects(
          tx(async (transaction) => {
            await f.ready(candidate, transaction);
            await budgets.compareAndSwap(
              item.proof.owner_budget_id,
              '1',
              {
                pending_object_id: candidate.proof.id,
                pending_validity_date: candidate.date,
              },
              transaction,
            );
            // Missing READY->ATTACHED and old-object detach must fail deferred commit.
          }),
          (error) => error.original?.code === '23514',
        );
        await assert.rejects(
          tx((transaction) =>
            rows(
              'UPDATE public.budgets_pdf SET revision=revision WHERE id=:id',
              { id: item.proof.owner_budget_id },
              transaction,
            ),
          ),
          (error) => error.original?.code === '23514',
        );
        assert.equal(
          (await Budget.findByPk(item.proof.owner_budget_id)).pending_object_id,
          item.proof.id,
        );
        assert.equal(
          (await ObjectModel.findByPk(candidate.proof.id)).state,
          'UPLOADING',
        );
        await f.orphan(candidate);
        await f.worker.processClaim(await f.claim(candidate));
      },
    );
    await t.test(
      'final durable authority has no inconsistent references',
      async () => {
        assert.deepEqual(
          await rows(
            `SELECT o.id FROM public.budget_pdf_objects o WHERE (state='ATTACHED') IS DISTINCT FROM EXISTS(SELECT 1 FROM public.budgets_pdf b WHERE b.pending_object_id=o.id OR b.published_object_id=o.id)`,
          ),
          [],
        );
      },
    );
  } finally {
    await f.db.close();
  }
});
