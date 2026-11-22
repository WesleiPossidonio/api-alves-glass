import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { openBudgetGateEnvironment } from '../../support/budgets/gate-environment.js';
import BudgetPdf from '../../../src/app/models/BudgetPdf.js';
import BudgetPdfObject from '../../../src/app/models/BudgetPdfObject.js';
import Manager from '../../../src/app/models/BudgetCommercialManager.js';
import Permission from '../../../src/app/models/BudgetCommercialPermission.js';
import Audit from '../../../src/app/models/BudgetCommercialPermissionAudit.js';
import { BudgetPdfRepositoryClient } from '../../../src/app/repositories/BudgetPdfRepository.js';
import { BudgetPdfObjectRepositoryClient } from '../../../src/app/repositories/BudgetPdfObjectRepository.js';
import { BudgetCommercialAuthorizationRepositoryClient } from '../../../src/app/repositories/BudgetCommercialAuthorizationRepository.js';
import { createBudgetAuthorizationService } from '../../../src/app/services/BudgetAuthorizationService.js';
import {
  BudgetPdfStorageServiceClient,
  budgetObjectKey,
} from '../../../src/app/services/BudgetPdfStorageService.js';
import { createBudgetPdfCleanupWorker } from '../../../src/app/services/BudgetPdfCleanupWorker.js';

test('T022 real PostgreSQL17 + MinIO + foundation services (no HTTP use cases)', async (t) => {
  const { target, db, rows, client } = await openBudgetGateEnvironment();
  const models = [BudgetPdf, BudgetPdfObject, Manager, Permission, Audit];
  models.forEach((model) => model.init(db)); // no sync; migrations own schema
  const budgets = new BudgetPdfRepositoryClient();
  const objects = new BudgetPdfObjectRepositoryClient();
  const authRepository = new BudgetCommercialAuthorizationRepositoryClient();
  const authorization = createBudgetAuthorizationService({
    repository: authRepository,
  });
  const storage = new BudgetPdfStorageServiceClient({
    client,
    repository: objects,
    env: process.env,
  });
  const alerts = [];
  const worker = createBudgetPdfCleanupWorker({
    repository: objects,
    storage,
    alert: (code) => alerts.push(code),
  });
  const tx = (fn) => objects.transaction(fn);
  // Repeated runs retain terminal evidence. A single 25-row sweep no longer
  // necessarily visits this run's UUID; exercise bounded pagination explicitly.
  async function sweepRegistry() {
    const count = Number(
      (await rows('SELECT count(*) AS n FROM public.budget_pdf_objects'))[0].n,
    );
    for (let page = 0; page < Math.ceil(count / 25) + 1; page++)
      await worker.reconcileRegistry();
  }
  async function sweepPrefix(executor) {
    let count = 0;
    for await (const _entry of client.listObjectsV2(
      storage.bucket,
      'budgets-pdf/',
      true,
    ))
      count++;
    for (let page = 0; page < Math.ceil(count / 25) + 1; page++)
      await executor.reconcilePrefix();
  }
  const bytes = await readFile(
    new URL('../../fixtures/budgets/plain.pdf', import.meta.url),
  );
  const user = randomUUID(),
    member = randomUUID(),
    technical = randomUUID(),
    sector = randomUUID(),
    otherSector = randomUUID();
  let account, current, published;
  const token = randomUUID();
  const legacyBefore = JSON.stringify(
    await rows('SELECT to_jsonb(b) AS value FROM public.budget b ORDER BY id'),
  );
  async function intent(owner = randomUUID(), expectedRevision = null) {
    const proof = await storage.prepare(bytes, owner);
    const lease = randomUUID();
    await tx((transaction) =>
      objects.createIntent(
        {
          ...proof,
          created_by: technical,
          validity_date: '2027-01-01',
          expected_revision: expectedRevision,
          lease_token: lease,
          lease_until: new Date(Date.now() + 120000),
        },
        transaction,
      ),
    );
    return { proof, lease };
  }
  async function ready(proof, lease, transaction) {
    await objects.lockOwned(proof, transaction);
    await objects.compareAndSwapLease(
      {
        id: proof.id,
        token: lease,
        state: 'UPLOADING',
        nextState: 'READY',
        values: {
          size_bytes: proof.size_bytes,
          sha256: proof.sha256,
          content_type: 'application/pdf',
          confirmed_at: new Date(),
        },
      },
      transaction,
    );
  }
  async function orphan(proof) {
    await tx(async (transaction) => {
      await objects.lockOwned(proof, transaction);
      await rows(
        "UPDATE public.budget_pdf_objects SET state='CLEANUP_PENDING',lease_token=NULL,lease_until=NULL WHERE id=:id",
        { id: proof.id },
        transaction,
      );
    });
  }
  async function claim(id) {
    // Retained operational evidence can exceed one claim batch. Prioritize only
    // this fixture, including CLEANING restart/reconciled late-PUT claims.
    // Never purge evidence or change the production claim algorithm.
    await rows(
      `UPDATE public.budget_pdf_objects SET
       next_attempt_at=TIMESTAMPTZ '1900-01-01',
       lease_until=CASE WHEN state='CLEANING' THEN TIMESTAMPTZ '1900-01-01' ELSE lease_until END
       WHERE id=:id AND state IN ('CLEANUP_PENDING','CLEANING')`,
      { id },
    );
    const claims = await tx((transaction) => objects.claimCleanup(transaction));
    const result = claims.find((row) => row.id === id);
    assert.ok(result, 'expected durable claim');
    return result;
  }
  try {
    await t.test(
      'schema/model correspondence, indexes, deferred FKs and all four applied migrations',
      async () => {
        const applied = await rows(
          'SELECT name FROM public."SequelizeMeta" ORDER BY name',
        );
        assert.equal(
          applied.filter((row) => /^202611(?:27|28|29|30)/.test(row.name))
            .length,
          4,
        );
        for (const model of models) {
          const table = model.getTableName().tableName;
          const columns = await rows(
            "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=:table",
            { table },
          );
          for (const [name, attribute] of Object.entries(model.rawAttributes)) {
            const column = columns.find(
              (row) => row.column_name === attribute.field,
            );
            assert.ok(column, `${table}.${name}`);
            if (attribute.allowNull === false)
              assert.equal(column.is_nullable, 'NO');
            if (attribute.type.key === 'DATEONLY')
              assert.equal(column.data_type, 'date');
            if (attribute.type.key === 'BIGINT')
              assert.equal(column.data_type, 'bigint');
          }
        }
        const [constraints] = await rows(
          "SELECT count(*) FILTER(WHERE contype='f' AND condeferrable AND condeferred) AS n FROM pg_constraint WHERE conrelid='public.budgets_pdf'::regclass",
        );
        assert.equal(Number(constraints.n), 2);
      },
    );
    await t.test(
      'synthetic users: technical user has no admin role/membership/grants',
      async () => {
        for (const [id, role] of [
          [user, 'admin'],
          [member, 'user'],
          [technical, 'user'],
        ])
          await rows(
            `INSERT INTO public.users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at) VALUES (:id,:email,:email,'not-a-password',:role,'active','',now(),now())`,
            { id, role, email: `${id}@example.invalid` },
          );
        for (const id of [sector, otherSector])
          await rows(
            'INSERT INTO public.sectors(id,code,name,created_at,updated_at) VALUES (:id,:code,:code,now(),now())',
            { id, code: id.replaceAll('-', '') },
          );
        [account] = await rows(
          'SELECT id FROM public.client ORDER BY id LIMIT 1',
        );
        assert.ok(account);
        await rows(
          'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:member,:sector,:user,now())',
          { member, sector, user },
        );
        await tx(async (transaction) => {
          await authRepository.grant(
            {
              user_id: member,
              sector_id: sector,
              operation: 'READ',
              granted_by: user,
            },
            transaction,
          );
          await authRepository.appendAudit(
            {
              id: randomUUID(),
              actor_user_id: user,
              target_user_id: member,
              sector_id: sector,
              action: 'GRANT',
              operation: 'READ',
            },
            transaction,
          );
        });
        await assert.rejects(
          tx((transaction) =>
            authorization.authorizeOperation(
              { actorId: technical, sectorId: sector, operation: 'READ' },
              transaction,
            ),
          ),
          { code: 'forbidden' },
        );
      },
    );
    await t.test(
      'qpdf invalid input creates neither intent nor MinIO key',
      async () => {
        const before = (
          await rows('SELECT count(*) AS n FROM public.budget_pdf_objects')
        )[0].n;
        for (const name of [
          'corrupt.pdf',
          'password-required.pdf',
          'warning-xref.pdf',
          'renamed-non-pdf.pdf',
        ])
          await assert.rejects(
            storage.prepare(
              await readFile(
                new URL(`../../fixtures/budgets/${name}`, import.meta.url),
              ),
              randomUUID(),
            ),
          );
        assert.equal(
          (await rows('SELECT count(*) AS n FROM public.budget_pdf_objects'))[0]
            .n,
          before,
        );
      },
    );
    await t.test(
      'durable intent -> real validated PUT/stat/hash -> pending reference committed atomically',
      async () => {
        const { proof, lease } = await intent();
        const confirmed = await storage.upload(proof, lease);
        assert.equal(
          confirmed.sha256,
          createHash('sha256').update(bytes).digest('hex'),
        );
        await tx(async (transaction) => {
          await ready(proof, lease, transaction);
          await budgets.create(
            {
              id: proof.owner_budget_id,
              client_id: account.id,
              sector_id: sector,
              created_by: user,
              commercial_number: randomUUID(),
              administrative_name: 'T022 synthetic',
              pending_object_id: proof.id,
              pending_validity_date: '2027-01-01',
            },
            transaction,
          );
          await rows(
            "UPDATE public.budget_pdf_objects SET state='ATTACHED' WHERE id=:id",
            { id: proof.id },
            transaction,
          );
        });
        current = proof;
        assert.equal(
          (await BudgetPdf.findByPk(proof.owner_budget_id)).revision,
          '1',
        );
        assert.equal(
          await tx((transaction) =>
            objects.referencesObject(proof.id, transaction),
          ),
          true,
        );
      },
    );
    await t.test(
      'private full/range reads under shared lock; both ownership and sector policy use real data',
      async () => {
        await tx(async (transaction) => {
          await authorization.authorizeOperation(
            { actorId: member, sectorId: sector, operation: 'READ' },
            transaction,
          );
          await budgets.lockBudget(current.owner_budget_id, transaction, {
            shared: true,
          });
          const row = await BudgetPdfObject.findByPk(current.id, {
            transaction,
          });
          const chunks = [];
          for await (const chunk of await storage.get(row)) chunks.push(chunk);
          assert.deepEqual(Buffer.concat(chunks), bytes);
          const range = [];
          for await (const chunk of await storage.get(row, {
            start: 0,
            length: 5,
          }))
            range.push(chunk);
          assert.equal(Buffer.concat(range).toString(), '%PDF-');
        });
        await assert.rejects(
          tx((transaction) =>
            authorization.authorizeOperation(
              { actorId: member, sectorId: otherSector, operation: 'READ' },
              transaction,
            ),
          ),
          { code: 'forbidden' },
        );
        await assert.rejects(
          tx((transaction) =>
            authorization.authorizeOperation(
              { actorId: member, sectorId: sector, operation: 'PUBLISH' },
              transaction,
            ),
          ),
          { code: 'forbidden' },
        );
        await assert.rejects(
          tx((transaction) =>
            authorization.authorizeClientRead(
              {
                clientId: randomUUID(),
                budget: { clientId: account.id, publishedObjectId: current.id },
                slot: 'published',
              },
              transaction,
            ),
          ),
          { code: 'budgetNotFound' },
        );
        await rows(
          'DELETE FROM public.user_sectors WHERE user_id=:member AND sector_id=:sector',
          { member, sector },
        );
        await assert.rejects(
          tx((transaction) =>
            authorization.authorizeOperation(
              { actorId: member, sectorId: sector, operation: 'READ' },
              transaction,
            ),
          ),
          { code: 'forbidden' },
        );
        const response = await fetch(
          `http://${target.minio.host}:${target.minio.port}/${target.bucket}/${current.object_key}`,
        );
        await response.arrayBuffer();
        assert.equal(response.status, 403);
      },
    );
    await t.test(
      'real concurrent CAS: exactly one winner; stale revision fails and rollback preserves references',
      async () => {
        const results = await Promise.allSettled(
          ['a', 'b'].map((name) =>
            tx(async (transaction) => {
              await budgets.lockBudget(current.owner_budget_id, transaction);
              return budgets.compareAndSwap(
                current.owner_budget_id,
                '1',
                { administrative_name: name },
                transaction,
              );
            }),
          ),
        );
        assert.equal(
          results.filter((result) => result.status === 'fulfilled').length,
          1,
        );
        assert.equal(
          results.find((result) => result.status === 'rejected').reason.code,
          'revisionMismatch',
        );
        assert.equal(
          (await BudgetPdf.findByPk(current.owner_budget_id)).revision,
          '2',
        );
        await assert.rejects(
          tx(async (transaction) => {
            await budgets.compareAndSwap(
              current.owner_budget_id,
              '2',
              { administrative_name: 'rollback' },
              transaction,
            );
            throw new Error('rollback');
          }),
        );
        assert.equal(
          (await BudgetPdf.findByPk(current.owner_budget_id)).revision,
          '2',
        );
      },
    );
    await t.test(
      'row lock and shared owner guard actually block a concurrent writer',
      async () => {
        const first = await db.transaction();
        try {
          await budgets.lockBudget(current.owner_budget_id, first, {
            shared: true,
          });
          await assert.rejects(
            db.transaction(async (second) => {
              await rows("SET LOCAL lock_timeout='150ms'", {}, second);
              await budgets.lockBudget(current.owner_budget_id, second);
            }),
            (error) => error.original?.code === '55P03',
          );
        } finally {
          await first.rollback();
        }
      },
    );
    await t.test(
      'publish pair then replace pending: both referenced objects protected from cleanup',
      async () => {
        await tx(async (transaction) => {
          await budgets.lockBudget(current.owner_budget_id, transaction);
          await budgets.compareAndSwap(
            current.owner_budget_id,
            '2',
            {
              published_object_id: current.id,
              published_validity_date: '2027-01-01',
              pending_object_id: null,
              pending_validity_date: null,
              first_published_at: new Date(),
            },
            transaction,
          );
        });
        published = current;
        const { proof, lease } = await intent(current.owner_budget_id, '3');
        await storage.upload(proof, lease);
        await tx(async (transaction) => {
          await ready(proof, lease, transaction);
          await budgets.compareAndSwap(
            current.owner_budget_id,
            '3',
            {
              pending_object_id: proof.id,
              pending_validity_date: '2027-01-01',
            },
            transaction,
          );
          await rows(
            "UPDATE public.budget_pdf_objects SET state='ATTACHED' WHERE id=:id",
            { id: proof.id },
            transaction,
          );
        });
        current = proof;
        for (const proof of [current, published]) {
          assert.equal(
            await tx((transaction) =>
              objects.referencesObject(proof.id, transaction),
            ),
            true,
          );
          assert.equal(
            await worker.processClaim({ ...proof, lease_token: token }),
            'stale',
          );
          await assert.rejects(
            storage.remove(await BudgetPdfObject.findByPk(proof.id)),
            { code: 'budgetLeaseLost' },
          );
          assert.ok(await storage.stat(proof));
        }
        await tx((transaction) =>
          authorization.authorizeClientRead(
            {
              clientId: account.id,
              budget: { clientId: account.id, publishedObjectId: published.id },
              slot: 'published',
            },
            transaction,
          ),
        );
        await assert.rejects(
          tx((transaction) =>
            authorization.authorizeClientRead(
              {
                clientId: account.id,
                budget: {
                  clientId: account.id,
                  publishedObjectId: published.id,
                },
                slot: 'pending',
              },
              transaction,
            ),
          ),
          { code: 'budgetNotFound' },
        );
      },
    );
    await t.test(
      'expired upload fenced; durable claim contention, expired token and repeated cleanup',
      async () => {
        const { proof, lease } = await intent();
        await rows(
          "UPDATE public.budget_pdf_objects SET lease_until=clock_timestamp()-interval '1 second' WHERE id=:id",
          { id: proof.id },
        );
        await assert.rejects(storage.upload(proof, lease), {
          code: 'budgetLeaseLost',
        });
        await sweepRegistry();
        // Retained failed runs may hold >25 unrelated retry candidates. Give
        // only this freshly created fixture priority; never purge old evidence.
        await rows(
          "UPDATE public.budget_pdf_objects SET next_attempt_at='2000-01-01' WHERE id=:id",
          { id: proof.id },
        );
        const batches = await Promise.all([
          tx((transaction) => objects.claimCleanup(transaction)),
          tx((transaction) => objects.claimCleanup(transaction)),
        ]);
        const claims = batches.flat().filter((row) => row.id === proof.id);
        assert.equal(claims.length, 1);
        const stale = claims[0];
        await rows(
          "UPDATE public.budget_pdf_objects SET lease_until=clock_timestamp()-interval '1 second' WHERE id=:id",
          { id: proof.id },
        );
        assert.equal(await worker.processClaim(stale), 'stale');
        const fresh = await claim(proof.id);
        assert.notEqual(fresh.lease_token, stale.lease_token);
        assert.equal(await worker.processClaim(fresh), 'removed');
        assert.equal(await worker.processClaim(fresh), 'stale');
      },
    );
    await t.test(
      'transport failure on real MinIO rolls back no references, durable retry resumes',
      async () => {
        const { proof, lease } = await intent();
        await storage.upload(proof, lease);
        await orphan(proof);
        const job = await claim(proof.id);
        // Real socket failure (not a fake storage success): wrong isolated port.
        const unavailable = new BudgetPdfStorageServiceClient({
          env: { ...process.env, MINIO_PORT: '1' },
          repository: objects,
          timeoutMs: 200,
        });
        const failed = createBudgetPdfCleanupWorker({
          repository: objects,
          storage: unavailable,
        });
        assert.equal(await failed.processClaim(job), 'retry');
        const row = await BudgetPdfObject.findByPk(proof.id);
        assert.equal(row.state, 'CLEANUP_PENDING');
        assert.equal(row.last_error_code, 'storageUnavailable');
        assert.ok(await storage.stat(proof));
        await rows(
          'UPDATE public.budget_pdf_objects SET next_attempt_at=clock_timestamp() WHERE id=:id',
          { id: proof.id },
        );
        assert.equal(
          await worker.processClaim(await claim(proof.id)),
          'removed',
        );
      },
    );
    await t.test(
      'crash after confirmed external DELETE before DB update: rollback then restart safe',
      async () => {
        const { proof, lease } = await intent();
        await storage.upload(proof, lease);
        await orphan(proof);
        const job = await claim(proof.id);
        const interrupted = new Proxy(objects, {
          get(target, key) {
            if (key === 'compareAndSwapLease')
              return async (input, transaction) => {
                if (input.nextState === 'REMOVED')
                  throw new Error('INJECTED_INTERRUPTION_AFTER_REAL_DELETE');
                return target.compareAndSwapLease(input, transaction);
              };
            return typeof target[key] === 'function'
              ? target[key].bind(target)
              : target[key];
          },
        });
        await assert.rejects(
          createBudgetPdfCleanupWorker({
            repository: interrupted,
            storage,
          }).processClaim(job),
          /INJECTED_INTERRUPTION/,
        );
        assert.equal(await storage.stat(proof), null);
        assert.equal(
          (await BudgetPdfObject.findByPk(proof.id)).state,
          'CLEANING',
        );
        await rows(
          "UPDATE public.budget_pdf_objects SET lease_until=clock_timestamp()-interval '1 second' WHERE id=:id",
          { id: proof.id },
        );
        assert.equal(
          await worker.processClaim(await claim(proof.id)),
          'removed',
        );
        // Simulates a remote PUT finishing late, not another usable upload key.
        await client.putObject(target.bucket, proof.object_key, bytes);
        await sweepRegistry();
        assert.equal(
          await worker.processClaim(await claim(proof.id)),
          'removed',
        );
        assert.equal(await storage.stat(proof), null);
      },
    );
    await t.test(
      'unknown objects: 24h grace, no actor and invalid actor cannot delete; technical registration recovers',
      async () => {
        const identity = { id: randomUUID(), owner_budget_id: randomUUID() };
        const key = budgetObjectKey(identity.owner_budget_id, identity.id);
        await client.putObject(target.bucket, key, bytes);
        await worker.reconcilePrefix();
        assert.equal(await BudgetPdfObject.findByPk(identity.id), null);
        // Inject only clock: server/storage/repositories stay real. Advance >24h.
        const now = () => Date.now() + 86401000;
        const noActor = createBudgetPdfCleanupWorker({
          repository: objects,
          storage,
          now,
          alert: (code) => alerts.push(code),
        });
        await sweepPrefix(noActor);
        assert.equal(await BudgetPdfObject.findByPk(identity.id), null);
        assert.ok(alerts.includes('budgetUnknownObjectNeedsTechnicalActor'));
        await assert.rejects(
          sweepPrefix(
            createBudgetPdfCleanupWorker({
              repository: objects,
              storage,
              now,
              reconcilerActorId: randomUUID(),
            }),
          ),
        );
        assert.equal(await BudgetPdfObject.findByPk(identity.id), null);
        await sweepPrefix(
          createBudgetPdfCleanupWorker({
            repository: objects,
            storage,
            now,
            reconcilerActorId: technical,
          }),
        );
        assert.equal(
          (await BudgetPdfObject.findByPk(identity.id)).created_by,
          technical,
        );
        assert.equal(
          await worker.processClaim(await claim(identity.id)),
          'removed',
        );
      },
    );
    await t.test(
      'worker run loop actually executes; final slots remain authoritative and legacy preserved',
      async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 300);
        await worker.run({ signal: controller.signal });
        for (const proof of [current, published])
          assert.ok(await storage.stat(proof));
        const inconsistent = await rows(
          `SELECT o.id FROM public.budget_pdf_objects o WHERE (state='ATTACHED') IS DISTINCT FROM EXISTS(SELECT 1 FROM public.budgets_pdf b WHERE b.pending_object_id=o.id OR b.published_object_id=o.id)`,
        );
        assert.deepEqual(inconsistent, []);
        assert.equal(
          JSON.stringify(
            await rows(
              'SELECT to_jsonb(b) AS value FROM public.budget b ORDER BY id',
            ),
          ),
          legacyBefore,
        );
        assert.equal(
          (
            await rows(
              'SELECT count(*) AS n FROM public.budget_commercial_permissions WHERE user_id=:technical',
              { technical },
            )
          )[0].n,
          '0',
        );
      },
    );
  } finally {
    await db.close();
  }
});
