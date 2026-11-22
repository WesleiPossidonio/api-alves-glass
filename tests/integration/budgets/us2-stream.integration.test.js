import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import {
  matrixFixture,
  barrier,
  waitForLock,
} from '../../support/budgets/matrix-fixture.js';
import { BudgetPdfStreamService } from '../../../src/app/services/BudgetPdfStreamService.js';
import { BudgetPdfPublishService } from '../../../src/app/services/BudgetPdfPublishService.js';
import { budgetEtag } from '../../../src/app/services/BudgetContractService.js';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';

test('T036 real PG17/MinIO protected streaming service, no HTTP transport', async (t) => {
  const f = await matrixFixture();
  const deps = {
    budgets: f.budgets,
    objects: f.objects,
    authorization: f.authorization,
    storage: f.storage,
  };
  const service = new BudgetPdfStreamService(deps),
    publisher = new BudgetPdfPublishService(deps);
  const actor = { id: f.clientId, type: 'client' },
    admin = { id: f.creator, type: 'user' };
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  async function published(bytes = buildPdf(), date = '2020-01-01') {
    const item = await f.attached({ bytes, date });
    await f.rows(
      'UPDATE public.budget_pdf_objects SET lease_token=NULL,lease_until=NULL WHERE id=:id',
      { id: item.proof.id },
    );
    await publisher.publish(
      item.proof.owner_budget_id,
      { pendingDocumentId: item.proof.id },
      admin,
      { ifMatch: budgetEtag(item.proof.owner_budget_id, '1') },
    );
    return item;
  }
  function collect() {
    const destination = new PassThrough(),
      chunks = [];
    destination.on('data', (chunk) => chunks.push(chunk));
    destination.on('error', () => {});
    return { destination, bytes: () => Buffer.concat(chunks) };
  }
  async function read(item, extra = {}, who = actor) {
    const output = collect();
    let descriptor;
    await service.stream(
      { id: item.proof.owner_budget_id, actor: who, ...extra },
      output.destination,
      {
        onReady(value) {
          descriptor = value;
        },
      },
    );
    return { descriptor, bytes: output.bytes() };
  }
  // A held sink applies real backpressure to real getObject. No fake storage
  // success: source and locks remain live until the sink is released or aborted.
  function held() {
    const gate = barrier();
    let pendingWrite;
    const destination = new Writable({
      highWaterMark: 1,
      write(chunk, enc, callback) {
        pendingWrite = callback;
        gate.release();
      },
    });
    destination.on('error', () => {});
    return {
      destination,
      arrived: gate.promise,
      release() {
        destination._write = (chunk, enc, cb) => cb();
        pendingWrite?.();
      },
    };
  }
  try {
    await t.test(
      'full and single ranges match uploaded bytes/hash, expired accessible,416 without bytes',
      async () => {
        const bytes = buildPdf({ size: 128 * 1024 }),
          item = await published(bytes);
        const full = await read(item);
        assert.equal(hash(full.bytes), hash(bytes));
        assert.equal(full.descriptor.status, 200);
        for (const [range, start, end] of [
          ['bytes=1-99', 1, 100],
          ['bytes=-17', bytes.length - 17, bytes.length],
          ['bytes=100-', 100, bytes.length],
          ['bytes=0-9999999', 0, bytes.length],
        ]) {
          const part = await read(item, { range, ifNoneMatch: '*' });
          assert.equal(part.descriptor.status, 206);
          assert.deepEqual(part.bytes, bytes.subarray(start, end));
        }
        for (const range of [
          'bytes=9999999-',
          'bytes=0-1,4-5',
          'bytes=-0',
          'invalid',
        ]) {
          const result = await read(item, { range });
          assert.equal(result.descriptor.status, 416);
          assert.equal(result.bytes.length, 0);
        }
        assert.equal(f.storage.streams, 0);
      },
    );
    await t.test(
      'private/foreign/absent404; no client-selected slot/key/id; READ independent and revoked next request',
      async () => {
        const item = await published(),
          privateItem = await f.attached();
        for (const [target, who] of [
          [privateItem, actor],
          [item, { id: await f.client(), type: 'client' }],
          [{ proof: { owner_budget_id: randomUUID() } }, actor],
        ])
          await assert.rejects(read(target, {}, who), { code: 'notFound' });
        for (const extra of [
          { slot: 'pending' },
          { slot: 'published' },
          { clientId: f.clientId },
          { objectKey: item.proof.object_key },
          { documentId: item.proof.id },
        ])
          await assert.rejects(read(item, extra), { code: 'validation' });
        const user = { id: await f.user(), type: 'user' };
        await f.rows(
          'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:user,:sector,:admin,now())',
          { user: user.id, sector: f.sectorId, admin: f.creator },
        );
        await f.rows(
          "INSERT INTO public.budget_commercial_permissions(user_id,sector_id,operation,granted_by) VALUES (:user,:sector,'READ',:admin)",
          { user: user.id, sector: f.sectorId, admin: f.creator },
        );
        assert.equal(
          (await read(privateItem, { slot: 'pending' }, user)).descriptor
            .status,
          200,
        );
        await f.rows(
          "DELETE FROM public.budget_commercial_permissions WHERE user_id=:user AND sector_id=:sector AND operation='READ'",
          { user: user.id, sector: f.sectorId },
        );
        await assert.rejects(read(item, { slot: 'published' }, user), {
          code: 'notFound',
        });
      },
    );
    await t.test(
      'two shared readers coexist, publication blocks at owner guard, cleanup cannot delete current object',
      async () => {
        const old = await published(buildPdf({ size: 1024 * 1024 }));
        // Only fixture setup for a replacement candidate; no US3 implementation.
        const next = await f.intent({
          owner: old.proof.owner_budget_id,
          revision: '2',
          date: '2028-01-01',
        });
        await f.storage.upload(next.proof, next.token);
        await f.tx(async (tx) => {
          await f.budgets.lockBudget(old.proof.owner_budget_id, tx);
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
        const sinks = [held(), held()],
          controllers = [new AbortController(), new AbortController()];
        const readers = sinks.map((sink, i) =>
          service
            .stream(
              { id: old.proof.owner_budget_id, actor },
              sink.destination,
              { signal: controllers[i].signal },
            )
            .catch((error) => error),
        );
        let publishing;
        const entered = barrier();
        let pid;
        try {
          await Promise.all(sinks.map((s) => s.arrived));
          assert.equal(f.storage.streams, 2);
          const spyBudgets = new Proxy(f.budgets, {
            get(target, key) {
              if (key === 'lockBudget')
                return async (id, tx, options) => {
                  pid = (
                    await f.rows('SELECT pg_backend_pid() AS pid', {}, tx)
                  )[0].pid;
                  entered.release();
                  return target.lockBudget(id, tx, options);
                };
              return typeof target[key] === 'function'
                ? target[key].bind(target)
                : target[key];
            },
          });
          const contender = new BudgetPdfPublishService({
            ...deps,
            budgets: spyBudgets,
          });
          publishing = contender.publish(
            old.proof.owner_budget_id,
            { pendingDocumentId: next.proof.id },
            admin,
            { ifMatch: budgetEtag(old.proof.owner_budget_id, '3') },
          );
          await entered.promise;
          await waitForLock(f.rows, pid);
          assert.equal(
            (await f.Budget.findByPk(old.proof.owner_budget_id))
              .published_object_id,
            old.proof.id,
          );
          assert.ok(await f.storage.stat(old.proof));
          const claims = await f.tx((tx) => f.objects.claimCleanup(tx));
          assert.ok(!claims.some((row) => row.id === old.proof.id));
          // A malformed current-object job cannot bypass owner/reference protection.
          const malformed = f.worker.processClaim({
            ...old.proof,
            lease_token: randomUUID(),
          });
          sinks[0].release();
          await readers[0];
          await waitForLock(f.rows, pid); // second reader alone still protects owner
          controllers[1].abort();
          await readers[1];
          await publishing;
          await malformed;
          assert.equal(f.storage.streams, 0);
          assert.equal(
            (await f.ObjectModel.findByPk(old.proof.id)).state,
            'CLEANUP_PENDING',
          );
          // Claim this fixture first; retain all other evidence, no purge/batch assumptions.
          await f.rows(
            "UPDATE public.budget_pdf_objects SET next_attempt_at='2000-01-01' WHERE id=:id",
            { id: old.proof.id },
          );
          const claim = (await f.tx((tx) => f.objects.claimCleanup(tx))).find(
            (row) => row.id === old.proof.id,
          );
          assert.ok(claim);
          assert.equal(await f.worker.processClaim(claim), 'removed');
          assert.equal(await f.storage.stat(old.proof), null);
          assert.equal((await read(next)).descriptor.status, 200); // same budget URL resolves new published
        } finally {
          controllers.forEach((c) => c.abort());
          sinks.forEach((s) => s.release());
          await Promise.allSettled(readers);
          if (publishing) await publishing.catch(() => {});
        }
      },
    );
    await t.test(
      'abort/timeout/destination disconnect release actual MinIO streams and owner lock',
      async () => {
        const item = await published(buildPdf({ size: 1024 * 1024 }));
        for (const mode of ['abort', 'timeout', 'close']) {
          const sink = held(),
            controller = new AbortController();
          const limited = new BudgetPdfStreamService({
            ...deps,
            timeoutMs: mode === 'timeout' ? 200 : 5000,
          });
          const running = limited
            .stream(
              { id: item.proof.owner_budget_id, actor },
              sink.destination,
              { signal: controller.signal },
            )
            .catch((error) => error);
          await sink.arrived;
          if (mode === 'abort') controller.abort();
          if (mode === 'close') sink.destination.destroy();
          assert.equal((await running).code, 'storageUnavailable');
          assert.equal(f.storage.streams, 0);
          await f.tx((tx) =>
            f.budgets.lockBudget(item.proof.owner_budget_id, tx),
          );
        }
        assert.equal((await read(item)).descriptor.status, 200);
      },
    );
  } finally {
    await f.db.close();
  }
});
