import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { literal } from 'sequelize';
import { matrixFixture } from '../../support/budgets/matrix-fixture.js';
import { BudgetPdfCreateService } from '../../../src/app/services/BudgetPdfCreateService.js';
import { BudgetPdfReadService } from '../../../src/app/services/BudgetPdfReadService.js';
import { BudgetPdfStorageServiceClient } from '../../../src/app/services/BudgetPdfStorageService.js';
import { transportFault } from '../../support/budgets/transport-fault.js';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';
import { publicBudgetError } from '../../../src/app/services/BudgetContractService.js';

test('T025/T026 real create/read services on authenticated PG17/MinIO/qpdf', async (t) => {
  const f = await matrixFixture();
  const common = {
    budgets: f.budgets,
    objects: f.objects,
    authorization: f.authorization,
  };
  const create = new BudgetPdfCreateService({ ...common, storage: f.storage });
  const read = new BudgetPdfReadService({
    ...common,
    cursorSecret: 'integration-only-cursor-key-at-least-32-bytes',
  });
  const actor = { id: f.creator, type: 'user' },
    member = { id: await f.user(), type: 'user' },
    reader = { id: await f.user(), type: 'user' };
  const legacy = JSON.stringify(
    await f.rows(
      'SELECT to_jsonb(b) AS value FROM public.budget b ORDER BY id',
    ),
  );
  const base = {
    sectorId: f.sectorId,
    clientId: f.clientId,
    administrativeName: 'US1 synthetic',
    validityDate: '0001-01-01',
  };
  const input = (number = randomUUID()) => ({
    ...base,
    commercialNumber: number,
  });
  const bytes = buildPdf();
  async function grant(user, operation) {
    await f.rows(
      'INSERT INTO public.budget_commercial_permissions(user_id,sector_id,operation,granted_by) VALUES (:user,:sector,:operation,:admin)',
      { user, sector: f.sectorId, operation, admin: actor.id },
    );
  }
  async function counts() {
    return await f.rows(
      'SELECT (SELECT count(*) FROM public.budgets_pdf) AS budgets,(SELECT count(*) FROM public.budget_pdf_objects) AS objects',
    );
  }
  async function cleanupNew(before) {
    const rows = await f.rows(
      "SELECT * FROM public.budget_pdf_objects WHERE NOT(id=ANY(CAST(:ids AS uuid[]))) AND state='CLEANUP_PENDING'",
      { ids: `{${before.join(',')}}` },
    );
    for (const row of rows) {
      let job;
      for (let page = 0; page < 10 && !job; page++)
        job = (await f.tx((tx) => f.objects.claimCleanup(tx))).find(
          (claim) => claim.id === row.id,
        );
      assert.ok(job);
      await f.worker.processClaim(job);
      assert.equal(await f.storage.stat(row), null);
    }
    return rows;
  }
  try {
    for (const user of [member.id, reader.id])
      await f.rows(
        'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:user,:sector,:admin,now())',
        { user, sector: f.sectorId, admin: actor.id },
      );
    await grant(member.id, 'CREATE_EDIT');
    await grant(reader.id, 'READ');
    await t.test(
      'create-only collaborator gets minimal revision1; real bytes, author and private pairs durable',
      async () => {
        const result = await create.create(input('00042'), member, bytes);
        assert.deepEqual(Object.keys(result).sort(), [
          'id',
          'pendingDocumentId',
          'revision',
        ]);
        assert.equal(result.revision, '1');
        const stored = await f.Budget.findByPk(result.id),
          object = await f.ObjectModel.findByPk(result.pendingDocumentId);
        assert.equal(stored.created_by, member.id);
        assert.equal(stored.commercial_number, '00042');
        assert.equal(stored.pending_validity_date, '0001-01-01');
        assert.equal(stored.published_object_id, null);
        assert.equal(stored.first_published_at, null);
        assert.equal(object.state, 'ATTACHED');
        assert.equal(object.lease_token, null);
        assert.equal(object.expected_revision, null);
        assert.equal(object.created_by, member.id);
        assert.equal(Number((await f.storage.stat(object)).size), bytes.length);
        await assert.rejects(read.detail(result.id, member), {
          code: 'notFound',
        });
        const dto = await read.detail(result.id, reader);
        assert.equal(dto.createdBy, member.id);
        assert.equal(dto.pending.documentId, result.pendingDocumentId);
        assert.equal(dto.published, null);
        await assert.rejects(
          f.tx((tx) =>
            f.authorization.authorizeClientRead(
              {
                clientId: f.clientId,
                budget: {
                  clientId: stored.client_id,
                  publishedObjectId: stored.published_object_id,
                },
                slot: 'published',
              },
              tx,
            ),
          ),
          { code: 'budgetNotFound' },
        );
      },
    );
    await t.test(
      'exact text uniqueness is scoped; concurrent duplicate returns one409 and controlled cleanup',
      async () => {
        const before = (
          await f.rows('SELECT id FROM public.budget_pdf_objects')
        ).map((row) => row.id);
        const number = 'race-' + randomUUID();
        const outcomes = await Promise.allSettled([
          create.create(input(number), actor, bytes),
          create.create(input(number), actor, bytes),
        ]);
        assert.equal(
          outcomes.filter((result) => result.status === 'fulfilled').length,
          1,
        );
        assert.equal(
          outcomes.find((result) => result.status === 'rejected').reason.code,
          'duplicateNumber',
        );
        assert.equal(
          (
            await f.rows(
              'SELECT id FROM public.budgets_pdf WHERE sector_id=:sector AND commercial_number=:number',
              { sector: f.sectorId, number },
            )
          ).length,
          1,
        );
        const orphans = await cleanupNew(before);
        assert.equal(orphans.length, 1);
        await create.create(input('42'), actor, bytes);
        const other = await f.sector();
        await create.create(
          { ...input('00042'), sectorId: other },
          actor,
          bytes,
        );
        const page = await read.list(
          { sectorId: f.sectorId, commercialNumber: '00042' },
          reader,
        );
        assert.equal(page.items.length, 1);
        assert.equal(page.items[0].commercialNumber, '00042');
      },
    );
    await t.test(
      'missing/invalid references and permissions reject without registry; qpdf negatives zero PUT',
      async () => {
        const before = await counts();
        for (const values of [
          { ...input(), clientId: randomUUID() },
          { ...input(), sectorId: randomUUID() },
          { ...input(), validityDate: '2027-02-29' },
          { ...input(), commercialNumber: ' 42' },
          { ...input(), author: actor.id },
        ])
          await assert.rejects(create.create(values, actor, bytes), {
            code: 'validation',
          });
        await assert.rejects(create.create(input(), reader, bytes), {
          code: 'forbidden',
        });
        await assert.rejects(
          create.create(
            { ...input(), sectorId: await f.sector() },
            member,
            bytes,
          ),
          { code: 'forbidden' },
        );
        for (const [content, code] of [
          [Buffer.alloc(0), 'invalidPdf'],
          [Buffer.from('not PDF'), 'unsupportedMediaType'],
          [buildPdf({ size: 10485761 }), 'fileTooLarge'],
          [Buffer.from('%PDF- malformed'), 'invalidPdf'],
        ])
          await assert.rejects(create.create(input(), actor, content), {
            code,
          });
        assert.deepEqual(await counts(), before);
      },
    );
    await t.test(
      'permission revoked while real PUT runs: commit denied, no partial budget, object cleanup durable',
      async () => {
        const before = (
          await f.rows('SELECT id FROM public.budget_pdf_objects')
        ).map((row) => row.id);
        const storage = new Proxy(f.storage, {
          get(target, key) {
            if (key === 'upload')
              return async (...args) => {
                const result = await target.upload(...args);
                await f.rows(
                  "DELETE FROM public.budget_commercial_permissions WHERE user_id=:id AND sector_id=:sector AND operation='CREATE_EDIT'",
                  { id: member.id, sector: f.sectorId },
                );
                return result;
              };
            return typeof target[key] === 'function'
              ? target[key].bind(target)
              : target[key];
          },
        });
        await assert.rejects(
          new BudgetPdfCreateService({ ...common, storage }).create(
            input(),
            member,
            bytes,
          ),
          { code: 'forbidden' },
        );
        const orphan = await cleanupNew(before);
        assert.equal(orphan.length, 1);
        assert.equal(await f.Budget.findByPk(orphan[0].owner_budget_id), null);
        await grant(member.id, 'CREATE_EDIT');
      },
    );
    await t.test(
      'real post-commit PUT transport failure stays recoverable and never creates usable budget',
      async () => {
        const before = (
            await f.rows('SELECT id FROM public.budget_pdf_objects')
          ).map((row) => row.id),
          proxy = await transportFault();
        try {
          const storage = new BudgetPdfStorageServiceClient({
            client: proxy.client,
            repository: f.objects,
            timeoutMs: 500,
          });
          const fault = proxy.arm('PUT', 'after');
          const work = new BudgetPdfCreateService({
            ...common,
            storage,
          }).create(input(), actor, bytes);
          work.catch(() => {});
          await fault.hit;
          await assert.rejects(work, (error) => {
            assert.deepEqual(publicBudgetError(error), {
              status: 503,
              body: { error: 'storageUnavailable' },
            });
            return true;
          });
          const orphan = await cleanupNew(before);
          assert.equal(orphan.length, 1);
          assert.equal(
            await f.Budget.findByPk(orphan[0].owner_budget_id),
            null,
          );
        } finally {
          await proxy.close();
        }
      },
    );
    await t.test(
      'external stat failure and lost lease are compensated using real persisted intents',
      async () => {
        for (const mode of ['stat', 'lease']) {
          const before = (
            await f.rows('SELECT id FROM public.budget_pdf_objects')
          ).map((row) => row.id);
          const storage = new BudgetPdfStorageServiceClient({
            repository: f.objects,
          });
          if (mode === 'stat')
            storage.stat = async () => {
              throw new Error('transport unavailable secret');
            };
          else {
            const upload = storage.upload.bind(storage);
            storage.upload = async (proof, ...args) => {
              const result = await upload(proof, ...args);
              await f.rows(
                "UPDATE public.budget_pdf_objects SET lease_until=clock_timestamp()-interval '1 second' WHERE id=:id",
                { id: proof.id },
              );
              return result;
            };
          }
          await assert.rejects(
            new BudgetPdfCreateService({ ...common, storage }).create(
              input(),
              actor,
              bytes,
            ),
            {
              code: mode === 'lease' ? 'budgetLeaseLost' : 'storageUnavailable',
            },
          );
          const orphan = await cleanupNew(before);
          assert.equal(orphan.length, 1);
          assert.equal(
            await f.Budget.findByPk(orphan[0].owner_budget_id),
            null,
          );
        }
      },
    );
    await t.test(
      'lost membership during PUT denies attachment; ambiguous commit keeps attached document protected',
      async () => {
        const before = (
          await f.rows('SELECT id FROM public.budget_pdf_objects')
        ).map((row) => row.id);
        const storage = new Proxy(f.storage, {
          get(target, key) {
            if (key === 'upload')
              return async (...args) => {
                const result = await target.upload(...args);
                await f.rows(
                  'DELETE FROM public.user_sectors WHERE user_id=:user AND sector_id=:sector',
                  { user: member.id, sector: f.sectorId },
                );
                return result;
              };
            return typeof target[key] === 'function'
              ? target[key].bind(target)
              : target[key];
          },
        });
        await assert.rejects(
          new BudgetPdfCreateService({ ...common, storage }).create(
            input(),
            member,
            bytes,
          ),
          { code: 'forbidden' },
        );
        assert.equal((await cleanupNew(before)).length, 1);
        await f.rows(
          'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:user,:sector,:admin,now())',
          { user: member.id, sector: f.sectorId, admin: actor.id },
        );
        let transactionCount = 0;
        const objects = new Proxy(f.objects, {
          get(target, key) {
            if (key === 'transaction')
              return async (callback) => {
                const result = await target.transaction(callback);
                if (++transactionCount === 3)
                  throw new Error('commit acknowledgement lost');
                return result;
              };
            return typeof target[key] === 'function'
              ? target[key].bind(target)
              : target[key];
          },
        });
        const values = input();
        await assert.rejects(
          new BudgetPdfCreateService({
            ...common,
            objects,
            storage: f.storage,
          }).create(values, actor, bytes),
          { code: 'storageUnavailable' },
        );
        const page = await read.list(
          { sectorId: f.sectorId, commercialNumber: values.commercialNumber },
          actor,
        );
        assert.equal(page.items.length, 1);
        const object = await f.ObjectModel.findByPk(
          page.items[0].pending.documentId,
        );
        assert.equal(object.state, 'ATTACHED');
        assert.ok(await f.storage.stat(object));
      },
    );
    await t.test(
      'keyset uses full PostgreSQL microseconds, ties and scope; READ never filters author',
      async () => {
        const sector = await f.sector(),
          created = [];
        // Fixture controls creation timestamp inside actual INSERT, never edits
        // protected created_at or relaxes migrations. Two groups share timestamps
        // and differ below JS millisecond precision.
        let index = 0;
        const budgets = new Proxy(f.budgets, {
          get(target, key) {
            if (key === 'create')
              return (values, transaction) =>
                target.create(
                  {
                    ...values,
                    created_at: literal(
                      `TIMESTAMPTZ '2026-01-01T00:00:00.${index++ % 2 ? '000002' : '000001'}Z'`,
                    ),
                  },
                  transaction,
                );
            return typeof target[key] === 'function'
              ? target[key].bind(target)
              : target[key];
          },
        });
        const timedCreate = new BudgetPdfCreateService({
          ...common,
          budgets,
          storage: f.storage,
        });
        for (let i = 0; i < 7; i++)
          created.push(
            await timedCreate.create(
              { ...input(String(i)), sectorId: sector },
              actor,
              bytes,
            ),
          );
        // Real generated timestamps already carry microseconds. Expected order from
        // SQL is authoritative; pages must contain every row once regardless ties.
        const expected = (
          await f.rows(
            'SELECT id FROM public.budgets_pdf WHERE sector_id=:sector ORDER BY created_at DESC,id DESC',
            { sector },
          )
        ).map((row) => row.id);
        let cursor,
          actual = [];
        do {
          const page = await read.list(
            { sectorId: sector, limit: '2', ...(cursor ? { cursor } : {}) },
            actor,
          );
          actual.push(...page.items.map((item) => item.id));
          cursor = page.nextCursor;
        } while (cursor);
        assert.deepEqual(actual, expected);
        assert.equal(new Set(actual).size, 7);
        const first = await read.list({ sectorId: sector, limit: 2 }, actor);
        await assert.rejects(
          read.list({ sectorId: f.sectorId, cursor: first.nextCursor }, actor),
          { code: 'invalidCursor' },
        );
        await assert.rejects(read.detail(created[0].id, reader), {
          code: 'notFound',
        });
      },
    );
    await t.test(
      'READ revoked after cursor issuance immediately denies continuation and all hidden details',
      async () => {
        const first = await read.list(
          { sectorId: f.sectorId, limit: 1 },
          reader,
        );
        assert.ok(first.nextCursor);
        await f.rows(
          "DELETE FROM public.budget_commercial_permissions WHERE user_id=:id AND sector_id=:sector AND operation='READ'",
          { id: reader.id, sector: f.sectorId },
        );
        await assert.rejects(
          read.list(
            { sectorId: f.sectorId, limit: 1, cursor: first.nextCursor },
            reader,
          ),
          { code: 'notFound' },
        );
        for (const id of [first.items[0].id, randomUUID()])
          await assert.rejects(read.detail(id, reader), { code: 'notFound' });
        await grant(reader.id, 'READ');
      },
    );
    await t.test(
      'legacy preserved, no inconsistent references, client/internal cross-scope never exposed',
      async () => {
        assert.equal(
          JSON.stringify(
            await f.rows(
              'SELECT to_jsonb(b) AS value FROM public.budget b ORDER BY id',
            ),
          ),
          legacy,
        );
        assert.deepEqual(
          await f.rows(
            "SELECT o.id FROM public.budget_pdf_objects o WHERE (o.state='ATTACHED') IS DISTINCT FROM EXISTS(SELECT 1 FROM public.budgets_pdf b WHERE b.pending_object_id=o.id OR b.published_object_id=o.id)",
          ),
          [],
        );
        await assert.rejects(
          read.list(
            { sectorId: f.sectorId },
            { id: f.clientId, type: 'client' },
          ),
          { code: 'forbidden' },
        );
        await assert.rejects(read.detail(randomUUID(), reader), {
          code: 'notFound',
        });
      },
    );
  } finally {
    await f.db.close();
  }
});
