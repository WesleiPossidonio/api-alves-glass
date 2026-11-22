import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { Writable } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import Jwt from 'jsonwebtoken';
import authConfig from '../../../src/config/auth.js';
import AuthSession from '../../../src/app/models/AuthSession.js';
import User from '../../../src/app/models/User.js';
import { csrfTokenForSession } from '../../../src/app/services/sessionSecurity.js';
import {
  matrixFixture,
  barrier,
  waitForLock,
} from '../../support/budgets/matrix-fixture.js';
import {
  buildPdf,
  fixtureBuffers,
} from '../../fixtures/budgets/build-fixtures.js';
import { BudgetPdfCreateService } from '../../../src/app/services/BudgetPdfCreateService.js';
import { BudgetPdfEditService } from '../../../src/app/services/BudgetPdfEditService.js';
import { BudgetPdfReplacementService } from '../../../src/app/services/BudgetPdfReplacementService.js';
import { BudgetPdfPublishService } from '../../../src/app/services/BudgetPdfPublishService.js';
import { BudgetPdfReadService } from '../../../src/app/services/BudgetPdfReadService.js';
import { ClientBudgetPdfService } from '../../../src/app/services/ClientBudgetPdfService.js';
import { BudgetPdfStreamService } from '../../../src/app/services/BudgetPdfStreamService.js';
import { createBudgetPdfCleanupWorker } from '../../../src/app/services/BudgetPdfCleanupWorker.js';
import { BudgetPdfController } from '../../../src/app/controllers/BudgetPdfController.js';
import { ClientBudgetPdfController } from '../../../src/app/controllers/ClientBudgetPdfController.js';
import { createBudgetPdfRouter } from '../../../src/app/meddleawares/budgetPdfHttp.js';
import {
  budgetEtag,
  budgetError,
} from '../../../src/app/services/BudgetContractService.js';

test('T045 US3 real HTTP, PostgreSQL17 and MinIO lifecycle', async (t) => {
  const f = await matrixFixture();
  f.db.options.define.underscored = true;
  AuthSession.init(f.db);
  User.init(f.db);
  const deps = {
    budgets: f.budgets,
    objects: f.objects,
    authorization: f.authorization,
    storage: f.storage,
  };
  const create = new BudgetPdfCreateService(deps),
    edit = new BudgetPdfEditService(deps),
    replace = new BudgetPdfReplacementService(deps),
    publish = new BudgetPdfPublishService(deps);
  const cursorSecret = 'us3-real-http-cursor-secret-with-32-bytes',
    stream = new BudgetPdfStreamService(deps);
  const transport = new BudgetPdfController({
    create,
    edit,
    replace,
    publish,
    stream,
    read: new BudgetPdfReadService({ ...deps, cursorSecret }),
  });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/budgets', createBudgetPdfRouter({ transport }));
  app.use(
    '/client/budgets',
    createBudgetPdfRouter({
      client: true,
      transport: new ClientBudgetPdfController({
        stream,
        read: new ClientBudgetPdfService({ ...deps, cursorSecret }),
      }),
    }),
  );
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`,
    admin = { id: f.creator, type: 'user' };
  async function session(id, type = 'user') {
    const sid = randomUUID(),
      csrf = csrfTokenForSession(sid);
    await AuthSession.create({
      id: sid,
      actor_type: type,
      user_id: type === 'user' ? id : null,
      client_id: type === 'client' ? id : null,
      expires_at: new Date(Date.now() + 600000),
    });
    const token = Jwt.sign(
      { sub: id, sid, actor_type: type },
      authConfig.secret,
      { expiresIn: 600 },
    );
    return {
      cookie: `access_token=${token}; csrf_token=${csrf}`,
      origin: 'http://localhost',
      'x-csrf-token': csrf,
    };
  }
  const headers = await session(f.creator),
    owner = await session(f.clientId, 'client');
  const bytesA = buildPdf(),
    bytesB = buildPdf({ size: 2048 }),
    bytesC = buildPdf({ size: 3072 });
  const input = () => ({
    sectorId: f.sectorId,
    clientId: f.clientId,
    commercialNumber: randomUUID(),
    administrativeName: 'US3',
    validityDate: '2027-01-01',
  });
  const make = () => create.create(input(), admin, bytesA);
  const snapshot = async (id) => (await f.Budget.findByPk(id)).toJSON();
  const opts = (row) => ({ ifMatch: budgetEtag(row.id, String(row.revision)) });
  async function request(method, path, body, rev, auth = headers, bytes) {
    let payload,
      h = { ...auth };
    if (rev) h['if-match'] = rev;
    if (method === 'PUT') {
      payload = new FormData();
      for (const [key, value] of Object.entries(body ?? {}))
        payload.append(key, value);
      if (bytes !== undefined)
        payload.append(
          'file',
          new Blob([bytes], { type: 'application/pdf' }),
          'budget.pdf',
        );
    } else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await fetch(base + path, {
      method,
      headers: h,
      body: payload,
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  }
  async function download(id, bytes) {
    const response = await fetch(`${base}/client/budgets/${id}/pdf`, {
      headers: owner,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(await response.arrayBuffer()))
        .digest('hex'),
      createHash('sha256').update(bytes).digest('hex'),
    );
  }
  async function member(operations, sector = f.sectorId) {
    const id = await f.user();
    await f.rows(
      'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:id,:sector,:admin,now())',
      { id, sector, admin: f.creator },
    );
    for (const operation of operations)
      await f.rows(
        'INSERT INTO public.budget_commercial_permissions(user_id,sector_id,operation,granted_by) VALUES (:id,:sector,:operation,:admin)',
        { id, sector, operation, admin: f.creator },
      );
    return { id, type: 'user' };
  }
  await t.test(
    'private corrections: destination authorization, references, UNIQUE, missing/stale revision, strict fields',
    async () => {
      const a = await make(),
        b = await make(),
        row = await snapshot(a.id),
        sector = await f.sector(),
        client = await f.client();
      const editor = await member(['CREATE_EDIT']);
      await assert.rejects(
        edit.edit(a.id, { sectorId: sector }, editor, opts(row)),
        { code: 'forbidden' },
      );
      await assert.rejects(
        edit.edit(a.id, { clientId: randomUUID() }, admin, opts(row)),
        { code: 'validation' },
      );
      const duplicate = await snapshot(b.id);
      await assert.rejects(
        edit.edit(
          a.id,
          { commercialNumber: duplicate.commercial_number },
          admin,
          opts(row),
        ),
        { code: 'duplicateNumber' },
      );
      for (const [revision, status] of [
        [undefined, 428],
        [budgetEtag(a.id, '99'), 412],
      ]) {
        assert.equal(
          (
            await request(
              'PATCH',
              `/budgets/${a.id}`,
              { administrativeName: 'x' },
              revision,
            )
          ).status,
          status,
        );
        assert.equal(
          (
            await request(
              'PUT',
              `/budgets/${a.id}/pending-pdf`,
              {},
              revision,
              headers,
              bytesB,
            )
          ).status,
          status,
        );
      }
      assert.equal(
        (
          await request(
            'PATCH',
            `/budgets/${a.id}`,
            { createdBy: randomUUID() },
            opts(row).ifMatch,
          )
        ).status,
        400,
      );
      const changed = await request(
        'PATCH',
        `/budgets/${a.id}`,
        {
          clientId: client,
          sectorId: sector,
          commercialNumber: '00042',
          validityDate: '2028-02-29',
        },
        opts(row).ifMatch,
      );
      assert.equal(changed.status, 200);
      assert.equal(changed.body.revision, '2');
      const after = await snapshot(a.id);
      assert.equal(after.pending_validity_date, '2028-02-29');
      assert.equal(after.created_by, row.created_by);
      assert.equal(after.commercial_number, '00042');
    },
  );
  await t.test(
    'A published remains downloadable during PUT; B replaced by C; manual publish swaps PDF/date and cleanup safely converges',
    async () => {
      const a = await make();
      const p = await request(
        'POST',
        `/budgets/${a.id}/publish`,
        { pendingDocumentId: a.pendingDocumentId },
        budgetEtag(a.id, '1'),
      );
      assert.equal(p.status, 200);
      const first = await snapshot(a.id);
      for (const field of [
        'clientId',
        'sectorId',
        'commercialNumber',
        'validityDate',
      ]) {
        const result = await request(
          'PATCH',
          `/budgets/${a.id}`,
          {
            [field]:
              field === 'validityDate'
                ? '2028-01-01'
                : field === 'commercialNumber'
                  ? 'N'
                  : randomUUID(),
          },
          opts(first).ifMatch,
        );
        assert.equal(result.status, 409);
        assert.equal(
          result.body.error.code,
          field === 'validityDate'
            ? 'replacementPdfRequired'
            : 'identityLocked',
        );
      }
      const reached = barrier(),
        release = barrier(),
        upload = f.storage.upload;
      f.storage.upload = async (...args) => {
        reached.release();
        await release.promise;
        return upload.apply(f.storage, args);
      };
      const waiting = request(
        'PUT',
        `/budgets/${a.id}/pending-pdf`,
        { validityDate: '2028-01-01' },
        opts(first).ifMatch,
        headers,
        bytesB,
      );
      await reached.promise;
      try {
        await download(a.id, bytesA);
        assert.deepEqual(await snapshot(a.id), first);
      } finally {
        release.release();
      }
      const b = await waiting;
      f.storage.upload = upload;
      assert.equal(b.status, 200, JSON.stringify(b.body));
      await download(a.id, bytesA);
      const pending = await snapshot(a.id);
      assert.equal(
        (
          await request(
            'GET',
            `/client/budgets/${a.id}`,
            undefined,
            undefined,
            owner,
          )
        ).body.validityDate,
        '2027-01-01',
      );
      const c = await request(
        'PUT',
        `/budgets/${a.id}/pending-pdf`,
        { validityDate: '2029-01-01' },
        opts(pending).ifMatch,
        headers,
        bytesC,
      );
      assert.equal(c.status, 200, JSON.stringify(c.body));
      assert.equal(
        (await f.ObjectModel.findByPk(b.body.pendingDocumentId)).state,
        'CLEANUP_PENDING',
      );
      // The shared migrated run can contain older recoverable jobs from previous
      // tests. Give this fixture priority without skipping the real claim/lease.
      await f.rows(
        "UPDATE public.budget_pdf_objects SET next_attempt_at='2000-01-01' WHERE id=:id AND state='CLEANUP_PENDING'",
        { id: b.body.pendingDocumentId },
      );
      const jobs = await f.tx((tx) => f.objects.claimCleanup(tx));
      const job = jobs.find((x) => x.id === b.body.pendingDocumentId);
      assert.ok(job);
      const failing = createBudgetPdfCleanupWorker({
        repository: f.objects,
        storage: {
          remove: async () => {
            throw Error('injected transport outage');
          },
        },
      });
      assert.equal(await failing.processClaim(job), 'retry');
      await download(a.id, bytesA);
      const current = await snapshot(a.id);
      assert.equal(current.pending_object_id, c.body.pendingDocumentId);
      assert.equal(
        current.first_published_at.toISOString(),
        first.first_published_at.toISOString(),
      );
      assert.equal(
        (
          await request(
            'PATCH',
            `/budgets/${a.id}`,
            { administrativeName: 'Novo nome' },
            opts(current).ifMatch,
          )
        ).status,
        200,
      );
      const named = await snapshot(a.id);
      assert.equal(
        (
          await request(
            'POST',
            `/budgets/${a.id}/publish`,
            { pendingDocumentId: c.body.pendingDocumentId },
            opts(named).ifMatch,
          )
        ).status,
        200,
      );
      await download(a.id, bytesC);
      const final = await snapshot(a.id);
      assert.equal(final.pending_object_id, null);
      assert.equal(final.published_validity_date, '2029-01-01');
      assert.equal(
        final.first_published_at.toISOString(),
        first.first_published_at.toISOString(),
      );
      await f.rows(
        'UPDATE public.budget_pdf_objects SET next_attempt_at=now() WHERE id=:id',
        { id: b.body.pendingDocumentId },
      );
      for (const j of jobs.filter((x) => x.id !== job.id))
        await f.worker.processClaim(j);
      const cleanup = await f.tx((tx) => f.objects.claimCleanup(tx));
      for (const j of cleanup) await f.worker.processClaim(j);
      assert.equal(
        (await f.ObjectModel.findByPk(a.pendingDocumentId)).state,
        'REMOVED',
      );
      assert.equal(
        (await f.ObjectModel.findByPk(b.body.pendingDocumentId)).state,
        'REMOVED',
      );
      assert.equal(
        (await f.ObjectModel.findByPk(c.body.pendingDocumentId)).state,
        'ATTACHED',
      );
      await download(a.id, bytesC);
    },
  );
  await t.test(
    'qpdf warning/password, missing PDF, size, storage confirmation and post-CAS rollback preserve both slots',
    async () => {
      const a = await make();
      await publish.publish(
        a.id,
        { pendingDocumentId: a.pendingDocumentId },
        admin,
        opts(a),
      );
      await replace.replace(
        a.id,
        {},
        admin,
        bytesB,
        opts(await snapshot(a.id)),
      );
      const before = await snapshot(a.id);
      for (const [bytes, status] of [
        [undefined, 422],
        [fixtureBuffers()['warning-xref.pdf'], 422],
        [fixtureBuffers()['password-required.pdf'], 422],
        [Buffer.alloc(10485761), 413],
      ]) {
        const r = await request(
          'PUT',
          `/budgets/${a.id}/pending-pdf`,
          {},
          opts(before).ifMatch,
          headers,
          bytes,
        );
        assert.equal(r.status, status);
        assert.deepEqual(await snapshot(a.id), before);
      }
      for (const stage of ['upload', 'confirmation', 'detach']) {
        const storage = Object.create(f.storage),
          objects = Object.create(f.objects);
        if (stage === 'upload')
          storage.upload = async () => {
            throw budgetError('storageUnavailable');
          };
        if (stage === 'confirmation')
          storage.stat = async () => {
            throw budgetError('storageUnavailable');
          };
        if (stage === 'detach')
          objects.enqueueDetached = async (...args) => {
            await f.objects.enqueueDetached(...args);
            throw budgetError('storageUnavailable');
          };
        await assert.rejects(
          new BudgetPdfReplacementService({
            ...deps,
            objects,
            storage,
          }).replace(a.id, {}, admin, bytesC, opts(before)),
          { code: 'storageUnavailable' },
        );
        assert.deepEqual(await snapshot(a.id), before);
        await download(a.id, bytesA);
      }
      const objects = await f.rows(
        'SELECT state FROM public.budget_pdf_objects WHERE owner_budget_id=:id',
        { id: a.id },
      );
      assert.equal(objects.filter((x) => x.state === 'ATTACHED').length, 2);
      assert.equal(
        objects.filter((x) => x.state === 'CLEANUP_PENDING').length,
        3,
      );
    },
  );
  await t.test(
    'independent permissions and revocation during upload forbid attachment',
    async () => {
      const a = await make(),
        row = await snapshot(a.id),
        actor = await member(['REPLACE_PDF']),
        auth = await session(actor.id);
      assert.equal(
        (await request('GET', `/budgets/${a.id}`, undefined, undefined, auth))
          .status,
        404,
      );
      assert.equal(
        (
          await request(
            'PATCH',
            `/budgets/${a.id}`,
            { administrativeName: 'x' },
            opts(row).ifMatch,
            auth,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request(
            'POST',
            `/budgets/${a.id}/publish`,
            { pendingDocumentId: a.pendingDocumentId },
            opts(row).ifMatch,
            auth,
          )
        ).status,
        403,
      );
      await assert.rejects(
        replace.replace(
          a.id,
          { validityDate: '2028-01-01' },
          actor,
          bytesB,
          opts(row),
        ),
        { code: 'forbidden' },
      );
      const success = await request(
        'PUT',
        `/budgets/${a.id}/pending-pdf`,
        {},
        opts(row).ifMatch,
        auth,
        bytesB,
      );
      assert.equal(success.status, 200);
      const before = await snapshot(a.id),
        storage = Object.create(f.storage);
      storage.upload = async (...args) => {
        const result = await f.storage.upload(...args);
        await f.rows(
          "DELETE FROM public.budget_commercial_permissions WHERE user_id=:id AND operation='REPLACE_PDF'",
          { id: actor.id },
        );
        return result;
      };
      await assert.rejects(
        new BudgetPdfReplacementService({ ...deps, storage }).replace(
          a.id,
          {},
          actor,
          bytesC,
          opts(before),
        ),
        { code: 'forbidden' },
      );
      assert.deepEqual(await snapshot(a.id), before);
    },
  );
  await t.test(
    'HTTP guards run before upload; invalid identity status and membership deny mutations',
    async () => {
      const a = await make(),
        row = await snapshot(a.id);
      for (const method of ['PATCH', 'PUT']) {
        const path = `/budgets/${a.id}${method === 'PUT' ? '/pending-pdf' : ''}`;
        for (const [auth, status] of [
          [{}, 401],
          [owner, 403],
          [{ ...headers, origin: '' }, 403],
          [{ ...headers, 'x-csrf-token': 'bad' }, 403],
        ]) {
          assert.equal(
            (await request(method, path, {}, opts(row).ifMatch, auth, bytesB))
              .status,
            status,
          );
        }
      }
      const actor = await member(['CREATE_EDIT', 'REPLACE_PDF']);
      await f.rows('DELETE FROM public.user_sectors WHERE user_id=:id', {
        id: actor.id,
      });
      await assert.rejects(
        edit.edit(a.id, { administrativeName: 'x' }, actor, opts(row)),
        { code: 'forbidden' },
      );
      await assert.rejects(
        replace.replace(a.id, {}, actor, bytesB, opts(row)),
        { code: 'forbidden' },
      );
      const inactive = await member(['CREATE_EDIT', 'REPLACE_PDF']);
      await f.rows(
        "UPDATE public.users SET status_users='inactive' WHERE id=:id",
        { id: inactive.id },
      );
      await assert.rejects(
        edit.edit(a.id, { administrativeName: 'x' }, inactive, opts(row)),
        { code: 'forbidden' },
      );
      await assert.rejects(
        replace.replace(a.id, {}, inactive, bytesB, opts(row)),
        { code: 'forbidden' },
      );
      assert.deepEqual(await snapshot(a.id), row);
      const count = await f.rows(
        'SELECT id FROM public.budget_pdf_objects WHERE owner_budget_id=:id',
        { id: a.id },
      );
      assert.equal(count.length, 1);
    },
  );
  await t.test(
    'real process restart preserves replacement candidate and published bytes; publication after restart exposes only new PDF',
    async () => {
      const a = await make();
      await publish.publish(
        a.id,
        { pendingDocumentId: a.pendingDocumentId },
        admin,
        opts(a),
      );
      const b = await replace.replace(
        a.id,
        { validityDate: '2028-01-01' },
        admin,
        bytesB,
        opts(await snapshot(a.id)),
      );
      const before = await snapshot(a.id);
      let priorPid;
      for (let round = 0; round < 2; round++) {
        const child = fork(
          new URL(
            '../../support/budgets/portal-http-child.js',
            import.meta.url,
          ),
          [],
          { env: process.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
        );
        const exited = once(child, 'exit'),
          timer = setTimeout(() => child.kill('SIGKILL'), 20000);
        try {
          const ready = await Promise.race([
            once(child, 'message').then(([msg]) => msg),
            exited.then(() => {
              throw Error('HTTP_CHILD_EXITED');
            }),
          ]);
          assert.notEqual(ready.pid, priorPid);
          priorPid = ready.pid;
          const response = await fetch(
            `http://127.0.0.1:${ready.port}/client/budgets/${a.id}/pdf`,
            { headers: owner },
          );
          assert.equal(response.status, 200);
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytesA);
          assert.deepEqual(await snapshot(a.id), before);
          child.kill(round ? 'SIGTERM' : 'SIGKILL');
          const [code, signal] = await exited;
          if (round) assert.equal(code, 0);
          else assert.equal(signal, 'SIGKILL');
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await exited;
          }
        }
      }
      await publish.publish(
        a.id,
        { pendingDocumentId: b.pendingDocumentId },
        admin,
        opts(before),
      );
      await download(a.id, bytesB);
      assert.equal(
        (await snapshot(a.id)).published_validity_date,
        '2028-01-01',
      );
    },
  );
  await t.test(
    'two uploads and edit/publication races use CAS; losers cannot attach and previous slots survive',
    async () => {
      for (const competitor of ['replace', 'edit', 'publish']) {
        const a = await make(),
          before = await snapshot(a.id),
          entered = barrier(),
          release = barrier(),
          storage = Object.create(f.storage);
        storage.upload = async (...args) => {
          const result = await f.storage.upload(...args);
          entered.release();
          await release.promise;
          return result;
        };
        const slow = new BudgetPdfReplacementService({
          ...deps,
          storage,
        }).replace(a.id, {}, admin, bytesC, opts(before));
        const rejected = assert.rejects(slow, { code: 'revisionMismatch' });
        await entered.promise;
        if (competitor === 'replace')
          await replace.replace(a.id, {}, admin, bytesB, opts(before));
        if (competitor === 'edit')
          await edit.edit(
            a.id,
            { administrativeName: 'winner' },
            admin,
            opts(before),
          );
        if (competitor === 'publish')
          await publish.publish(
            a.id,
            { pendingDocumentId: a.pendingDocumentId },
            admin,
            opts(before),
          );
        const won = await snapshot(a.id);
        release.release();
        await rejected;
        assert.deepEqual(await snapshot(a.id), won);
        const rows = await f.rows(
          "SELECT state FROM public.budget_pdf_objects WHERE owner_budget_id=:id AND state='CLEANUP_PENDING'",
          { id: a.id },
        );
        assert.ok(rows.length);
      }
    },
  );
  await t.test(
    'active reader protects A against manual publication of real replacement B and cleanup',
    async () => {
      const a = await make();
      await publish.publish(
        a.id,
        { pendingDocumentId: a.pendingDocumentId },
        admin,
        opts(a),
      );
      const b = await replace.replace(
        a.id,
        {},
        admin,
        bytesB,
        opts(await snapshot(a.id)),
      );
      const arrived = barrier(),
        release = barrier(),
        entered = barrier();
      const destination = new Writable({
        write(chunk, encoding, callback) {
          arrived.release();
          release.promise.then(() => callback());
        },
      });
      const reading = stream.stream(
        { id: a.id, actor: { id: f.clientId, type: 'client' } },
        destination,
      );
      const budgets = Object.create(f.budgets);
      let pid;
      budgets.lockBudget = async (...args) => {
        pid = (await f.rows('SELECT pg_backend_pid() AS pid', {}, args[1]))[0]
          .pid;
        entered.release();
        return f.budgets.lockBudget(...args);
      };
      await arrived.promise;
      const publishing = new BudgetPdfPublishService({
        ...deps,
        budgets,
      }).publish(
        a.id,
        { pendingDocumentId: b.pendingDocumentId },
        admin,
        opts(b),
      );
      try {
        await entered.promise;
        await waitForLock(f.rows, pid);
        assert.equal(
          (await snapshot(a.id)).published_object_id,
          a.pendingDocumentId,
        );
        assert.equal(
          (await f.ObjectModel.findByPk(a.pendingDocumentId)).state,
          'ATTACHED',
        );
        assert.ok(
          await f.storage.stat(
            await f.ObjectModel.findByPk(a.pendingDocumentId),
          ),
        );
      } finally {
        release.release();
        await reading;
      }
      await publishing;
      await download(a.id, bytesB);
      assert.equal(
        (await f.ObjectModel.findByPk(a.pendingDocumentId)).state,
        'CLEANUP_PENDING',
      );
    },
  );
});
