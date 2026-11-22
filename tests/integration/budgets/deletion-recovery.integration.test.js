import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import { once } from 'node:events';
import { fork, spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
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
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';
import { BudgetPdfCreateService } from '../../../src/app/services/BudgetPdfCreateService.js';
import { BudgetPdfReplacementService } from '../../../src/app/services/BudgetPdfReplacementService.js';
import { BudgetPdfPublishService } from '../../../src/app/services/BudgetPdfPublishService.js';
import { BudgetPdfReadService } from '../../../src/app/services/BudgetPdfReadService.js';
import { BudgetPdfStorageServiceClient } from '../../../src/app/services/BudgetPdfStorageService.js';
import { ClientBudgetPdfService } from '../../../src/app/services/ClientBudgetPdfService.js';
import { BudgetPdfStreamService } from '../../../src/app/services/BudgetPdfStreamService.js';
import { createBudgetPdfCleanupWorker } from '../../../src/app/services/BudgetPdfCleanupWorker.js';
import { BudgetPdfController } from '../../../src/app/controllers/BudgetPdfController.js';
import { ClientBudgetPdfController } from '../../../src/app/controllers/ClientBudgetPdfController.js';
import { createBudgetPdfRouter } from '../../../src/app/meddleawares/budgetPdfHttp.js';
import { budgetEtag } from '../../../src/app/services/BudgetContractService.js';

test('T048/T051 US4 actual HTTP deletion, recovery and concurrency on PG17/MinIO', async (t) => {
  const { BudgetPdfDeleteService } = await import(
    '../../../src/app/services/BudgetPdfDeleteService.js'
  );
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
    replace = new BudgetPdfReplacementService(deps),
    publish = new BudgetPdfPublishService(deps),
    deletion = new BudgetPdfDeleteService(deps);
  const stream = new BudgetPdfStreamService(deps),
    cursorSecret = 'us4-real-http-cursor-secret-with-32-bytes';
  const transport = new BudgetPdfController({
    create,
    publish,
    delete: deletion,
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
    admin = { id: f.creator, type: 'user' },
    bytes = buildPdf();
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
  const snapshot = async (id) =>
    (await f.Budget.findByPk(id))?.toJSON() ?? null;
  const opts = (row) => ({ ifMatch: budgetEtag(row.id, String(row.revision)) });
  const remove = (row, actor = admin, service = deletion) =>
    service.delete(row.id, { confirmBudgetId: row.id }, actor, opts(row));
  const objects = (id) =>
    f.rows(
      'SELECT * FROM public.budget_pdf_objects WHERE owner_budget_id=:id ORDER BY id',
      { id },
    );
  async function make(mode = 'private', extra = {}) {
    const a = await create.create(
      {
        sectorId: f.sectorId,
        clientId: f.clientId,
        commercialNumber: randomUUID(),
        administrativeName: 'US4',
        validityDate: '2027-01-01',
        ...extra,
      },
      admin,
      bytes,
    );
    if (mode !== 'private')
      await publish.publish(
        a.id,
        { pendingDocumentId: a.pendingDocumentId },
        admin,
        opts(a),
      );
    if (mode === 'both')
      await replace.replace(
        a.id,
        {},
        admin,
        buildPdf({ size: 2048 }),
        opts(await snapshot(a.id)),
      );
    return snapshot(a.id);
  }
  async function request(method, path, body, revision, auth = headers) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...auth,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(revision ? { 'if-match': revision } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  }
  async function absentHttp(id) {
    for (const path of [
      `/budgets/${id}`,
      `/budgets/${id}/pdf?slot=published`,
      `/budgets/${id}/pdf?slot=pending`,
      `/client/budgets/${id}`,
      `/client/budgets/${id}/pdf`,
    ]) {
      const r = await request(
        'GET',
        path,
        undefined,
        undefined,
        path.startsWith('/client') ? owner : headers,
      );
      assert.equal(r.status, 404, path);
      assert.equal(r.body.error.code, 'budgetNotFound');
    }
    for (const [path, auth] of [
      [`/budgets?sectorId=${f.sectorId}&limit=100`, headers],
      ['/client/budgets?limit=100', owner],
    ]) {
      const r = await request('GET', path, undefined, undefined, auth);
      assert.equal(r.status, 200);
      assert.ok(r.body.items.every((x) => x.id !== id));
    }
  }
  async function drain(id) {
    await f.rows(
      "UPDATE public.budget_pdf_objects SET next_attempt_at=now() WHERE owner_budget_id=:id AND state='CLEANUP_PENDING'",
      { id },
    );
    for (let i = 0; i < 100; i++) {
      const batch = await f.tx((tx) => f.objects.claimCleanup(tx));
      for (const job of batch) await f.worker.processClaim(job);
      if ((await objects(id)).every((x) => x.state === 'REMOVED')) break;
    }
    for (const row of await objects(id)) {
      assert.equal(row.state, 'REMOVED');
      assert.equal(await f.storage.stat(row), null);
    }
    const entries = await f.storage.operation(async (client) => {
      const listed = client.listObjectsV2(
        f.target.bucket,
        `budgets-pdf/${id}/`,
        true,
      );
      const result = [];
      for await (const item of listed) result.push(item);
      return result;
    });
    assert.deepEqual(entries, [], 'real MinIO prefix empty');
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
    'DELETE202 private/published/both: permanent SQL removal, inaccessible old URLs, real eventual physical removal',
    async () => {
      const untouched = await make('both', {
        clientId: await f.client(),
        sectorId: await f.sector(),
      });
      for (const mode of ['private', 'published', 'both']) {
        const row = await make(mode),
          before = await objects(row.id);
        const r = await request(
          'DELETE',
          `/budgets/${row.id}`,
          { confirmBudgetId: row.id },
          opts(row).ifMatch,
        );
        assert.equal(r.status, 202);
        assert.deepEqual(r.body, {
          id: row.id,
          deleted: true,
          cleanupPending: true,
        });
        assert.equal(
          r.headers.get('cache-control'),
          'private,no-store,max-age=0',
        );
        assert.equal(await snapshot(row.id), null);
        await absentHttp(row.id);
        for (const item of await objects(row.id)) {
          assert.equal(item.state, 'CLEANUP_PENDING');
          assert.equal(item.lease_token, null);
          assert.ok(await f.storage.stat(item));
        }
        assert.equal(
          (
            await request(
              'DELETE',
              `/budgets/${row.id}`,
              { confirmBudgetId: row.id },
              opts(row).ifMatch,
            )
          ).status,
          404,
        );
        await drain(row.id);
        assert.equal((await objects(row.id)).length, before.length);
      }
      assert.deepEqual(await snapshot(untouched.id), untouched);
      for (const item of await objects(untouched.id)) {
        assert.equal(item.state, 'ATTACHED');
        assert.ok(await f.storage.stat(item));
      }
    },
  );
  await t.test(
    'confirmation/revision/mass assignment, auth/Origin/CSRF and independent DELETE across current scope',
    async () => {
      const row = await make('both'),
        path = `/budgets/${row.id}`,
        input = { confirmBudgetId: row.id };
      for (const body of [
        {},
        { confirmBudgetId: randomUUID() },
        { ...input, objectKey: 'injected' },
        { ...input, clientId: f.clientId },
      ])
        assert.equal(
          (await request('DELETE', path, body, opts(row).ifMatch)).status,
          400,
        );
      assert.equal((await request('DELETE', path, input)).status, 428);
      assert.equal(
        (await request('DELETE', path, input, budgetEtag(row.id, '99'))).status,
        412,
      );
      for (const auth of [
        { ...headers, origin: '' },
        { ...headers, 'x-csrf-token': 'bad' },
        owner,
      ])
        assert.equal(
          (await request('DELETE', path, input, opts(row).ifMatch, auth))
            .status,
          403,
        );
      assert.equal(
        (await request('DELETE', path, input, opts(row).ifMatch, {})).status,
        401,
      );
      assert.equal(
        (
          await request(
            'DELETE',
            path + '?objectKey=injected',
            input,
            opts(row).ifMatch,
          )
        ).status,
        400,
      );
      for (const operation of ['READ', 'CREATE_EDIT', 'REPLACE_PDF', 'PUBLISH'])
        await assert.rejects(remove(row, await member([operation])), {
          code: 'forbidden',
        });
      await assert.rejects(
        remove(row, await member(['DELETE'], await f.sector())),
        { code: 'forbidden' },
      );
      for (const revoke of ['membership', 'permission', 'status']) {
        const actor = await member(['DELETE']);
        if (revoke === 'membership')
          await f.rows('DELETE FROM public.user_sectors WHERE user_id=:id', {
            id: actor.id,
          });
        if (revoke === 'permission')
          await f.rows(
            'DELETE FROM public.budget_commercial_permissions WHERE user_id=:id',
            { id: actor.id },
          );
        if (revoke === 'status')
          await f.rows(
            "UPDATE public.users SET status_users='inactive' WHERE id=:id",
            { id: actor.id },
          );
        await assert.rejects(remove(row, actor), { code: 'forbidden' });
      }
      assert.deepEqual(await snapshot(row.id), row);
      const actor = await member(['DELETE']),
        auth = await session(actor.id);
      assert.equal(
        (await request('GET', path, undefined, undefined, auth)).status,
        404,
      );
      assert.equal(
        (await request('DELETE', path, input, opts(row).ifMatch, auth)).status,
        202,
      );
      await drain(row.id);
    },
  );
  await t.test(
    'post-removal SQL fault rolls back budget, slots and all intent leases; no physical DELETE',
    async () => {
      const row = await make('both');
      const intent = await f.intent({ owner: row.id, revision: row.revision });
      const before = await objects(row.id),
        repository = Object.create(f.objects);
      repository.enqueueOwnerCleanup = async (...args) => {
        await f.objects.enqueueOwnerCleanup(...args);
        throw Error('injected after enqueue');
      };
      await assert.rejects(
        remove(
          row,
          admin,
          new BudgetPdfDeleteService({ ...deps, objects: repository }),
        ),
        { code: 'storageUnavailable' },
      );
      assert.deepEqual(await snapshot(row.id), row);
      assert.deepEqual(await objects(row.id), before);
      for (const item of before.filter((x) => x.state === 'ATTACHED'))
        assert.ok(await f.storage.stat(item));
      assert.equal(
        (await f.ObjectModel.findByPk(intent.proof.id)).lease_token,
        intent.token,
      );
      await remove(row);
      await drain(row.id);
    },
  );
  await t.test(
    'all owner registry states participate; old CLEANING token fenced, REMOVED retained, no other owner affected',
    async () => {
      const row = await make('both');
      const ready = await f.intent({ owner: row.id, revision: row.revision });
      await f.storage.upload(ready.proof, ready.token);
      await f.tx((tx) => f.ready(ready, tx));
      const old = await f.intent({ owner: row.id, revision: row.revision });
      await f.storage.upload(old.proof, old.token);
      await f.orphan(old);
      const terminal = await f.intent({
        owner: row.id,
        revision: row.revision,
      });
      await f.storage.upload(terminal.proof, terminal.token);
      await f.orphan(terminal);
      const claims = await f.tx((tx) => f.objects.claimCleanup(tx));
      const oldJob = claims.find((x) => x.id === old.proof.id),
        terminalJob = claims.find((x) => x.id === terminal.proof.id);
      assert.ok(oldJob);
      assert.ok(terminalJob);
      await f.worker.processClaim(terminalJob);
      for (const job of claims.filter(
        (x) => ![oldJob.id, terminalJob.id].includes(x.id),
      ))
        await f.worker.processClaim(job);
      const terminalBefore = (
        await f.ObjectModel.findByPk(terminal.proof.id)
      ).toJSON();
      await remove(row);
      assert.equal(await f.worker.processClaim(oldJob), 'stale');
      assert.deepEqual(
        (await f.ObjectModel.findByPk(terminal.proof.id)).toJSON(),
        terminalBefore,
      );
      for (const item of (await objects(row.id)).filter(
        (x) => x.id !== terminal.proof.id,
      )) {
        assert.equal(item.state, 'CLEANUP_PENDING');
        assert.equal(item.lease_token, null);
        assert.equal(item.lease_until, null);
      }
      await drain(row.id);
    },
  );
  await t.test(
    'real unavailable storage endpoint causes durable retry, never restores HTTP access',
    async () => {
      const row = await make('both');
      await remove(row);
      const blocker = http.createServer();
      blocker.listen(0, '127.0.0.1');
      await once(blocker, 'listening');
      const port = blocker.address().port;
      await new Promise((resolve) => blocker.close(resolve));
      const storage = new BudgetPdfStorageServiceClient({
        repository: f.objects,
        env: {
          ...process.env,
          MINIO_ENDPOINT: '127.0.0.1',
          MINIO_PORT: String(port),
        },
        timeoutMs: 200,
      });
      const worker = createBudgetPdfCleanupWorker({
        repository: f.objects,
        storage,
      });
      const jobs = await f.tx((tx) => f.objects.claimCleanup(tx));
      for (const job of jobs) {
        if (job.owner_budget_id === row.id)
          assert.equal(await worker.processClaim(job), 'retry');
        else await f.worker.processClaim(job);
      }
      for (const item of await objects(row.id)) {
        assert.equal(item.state, 'CLEANUP_PENDING');
        assert.equal(item.last_error_code, 'storageUnavailable');
        assert.ok(await f.storage.stat(item));
      }
      await absentHttp(row.id);
      await drain(row.id);
    },
  );
  await t.test(
    'two deletions, publication winning and deletion winning are serialized without resurrection',
    async () => {
      const row = await make('both');
      const outcomes = await Promise.allSettled([remove(row), remove(row)]);
      assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal(
        outcomes.find((x) => x.status === 'rejected').reason.code,
        'notFound',
      );
      await drain(row.id);
      const a = await make('private'),
        entered = barrier(),
        release = barrier(),
        storage = Object.create(f.storage);
      storage.stat = async (...args) => {
        const result = await f.storage.stat(...args);
        entered.release();
        await release.promise;
        return result;
      };
      const publishing = new BudgetPdfPublishService({
        ...deps,
        storage,
      }).publish(
        a.id,
        { pendingDocumentId: a.pending_object_id },
        admin,
        opts(a),
      );
      const rejected = assert.rejects(publishing, { code: 'notFound' });
      await entered.promise;
      try {
        await remove(a);
      } finally {
        release.release();
      }
      await rejected;
      await drain(a.id);
      const b = await make();
      await publish.publish(
        b.id,
        { pendingDocumentId: b.pending_object_id },
        admin,
        opts(b),
      );
      await assert.rejects(remove(b), { code: 'revisionMismatch' });
      assert.ok(await snapshot(b.id));
      await remove(await snapshot(b.id));
      await drain(b.id);
    },
  );
  await t.test(
    'replacement/publication commit while DELETE scope discovery is paused; stale DELETE never removes winner',
    async () => {
      for (const operation of ['replace', 'publish']) {
        const row = await make(),
          discovered = barrier(),
          release = barrier(),
          budgets = Object.create(f.budgets);
        budgets.findById = async (...args) => {
          const result = await f.budgets.findById(...args);
          discovered.release();
          await release.promise;
          return result;
        };
        const deleting = remove(
          row,
          admin,
          new BudgetPdfDeleteService({ ...deps, budgets }),
        );
        const rejected = assert.rejects(deleting, { code: 'revisionMismatch' });
        await discovered.promise;
        try {
          if (operation === 'replace')
            await replace.replace(
              row.id,
              {},
              admin,
              buildPdf({ size: 3072 }),
              opts(row),
            );
          else
            await publish.publish(
              row.id,
              { pendingDocumentId: row.pending_object_id },
              admin,
              opts(row),
            );
        } finally {
          release.release();
        }
        await rejected;
        const winner = await snapshot(row.id);
        assert.equal(winner.revision, '2');
        for (const item of (await objects(row.id)).filter(
          (x) => x.state === 'ATTACHED',
        ))
          assert.ok(await f.storage.stat(item));
        await remove(winner);
        await drain(row.id);
      }
    },
  );
  await t.test(
    'in-flight replacement PUT is fenced, cleanup before late PUT and reconciliation after terminal REMOVED',
    async () => {
      const row = await make('both'),
        entered = barrier(),
        release = barrier(),
        storage = Object.create(f.storage);
      let late;
      storage.operation = async function (callback, options) {
        // The first operation of upload is the real PUT; pause after durable refresh.
        if (!late) {
          late = true;
          entered.release();
          await release.promise;
        }
        return f.storage.operation(callback, options);
      };
      const replacing = new BudgetPdfReplacementService({
        ...deps,
        storage,
      }).replace(row.id, {}, admin, buildPdf({ size: 4096 }), opts(row));
      const rejected = assert.rejects(replacing, (error) =>
        ['notFound', 'budgetLeaseLost'].includes(error.code),
      );
      await entered.promise;
      const uploading = (await objects(row.id)).find(
        (x) => x.state === 'UPLOADING',
      );
      assert.ok(uploading);
      try {
        await remove(row);
        assert.equal(
          (await f.ObjectModel.findByPk(uploading.id)).lease_token,
          null,
        );
        await drain(row.id);
        assert.equal(await f.storage.stat(uploading), null);
      } finally {
        release.release();
      }
      await rejected;
      assert.equal(await snapshot(row.id), null);
      assert.ok(
        await f.storage.stat(uploading),
        'actual remote late PUT recreated bytes only',
      );
      for (
        let page = 0;
        page < 200 &&
        (await f.ObjectModel.findByPk(uploading.id)).state === 'REMOVED';
        page++
      )
        await f.worker.reconcileRegistry();
      assert.equal(
        (await f.ObjectModel.findByPk(uploading.id)).state,
        'CLEANUP_PENDING',
      );
      await drain(row.id);
      await absentHttp(row.id);
      await assert.rejects(
        f.tx((tx) =>
          f.objects.compareAndSwapLease(
            {
              id: uploading.id,
              token: uploading.lease_token,
              state: 'UPLOADING',
              nextState: 'READY',
            },
            tx,
          ),
        ),
        { code: 'budgetLeaseLost' },
      );
    },
  );
  await t.test(
    'active stream holds deletion until completion; protected objects cannot be claimed',
    async () => {
      const row = await make('both'),
        arrived = barrier(),
        release = barrier(),
        entered = barrier();
      let pid;
      const destination = new Writable({
        write(chunk, encoding, callback) {
          arrived.release();
          release.promise.then(() => callback());
        },
      });
      const reading = stream.stream(
        { id: row.id, actor: { id: f.clientId, type: 'client' } },
        destination,
      );
      await arrived.promise;
      const budgets = Object.create(f.budgets);
      budgets.lockBudget = async (...args) => {
        pid = (await f.rows('SELECT pg_backend_pid() AS pid', {}, args[1]))[0]
          .pid;
        entered.release();
        return f.budgets.lockBudget(...args);
      };
      const deleting = remove(
        row,
        admin,
        new BudgetPdfDeleteService({ ...deps, budgets }),
      );
      try {
        await entered.promise;
        await waitForLock(f.rows, pid);
        assert.deepEqual(await snapshot(row.id), row);
        const jobs = await f.tx((tx) => f.objects.claimCleanup(tx));
        assert.ok(jobs.every((x) => x.owner_budget_id !== row.id));
        for (const job of jobs) await f.worker.processClaim(job);
      } finally {
        release.release();
        await reading;
      }
      await deleting;
      await absentHttp(row.id);
      await drain(row.id);
    },
  );
  await t.test(
    'revocation serialized before authorization denies deletion; recheck before commit denies changed grant',
    async () => {
      const row = await make(),
        actor = await member(['DELETE']);
      const acquired = barrier(),
        release = barrier();
      const revocation = f.tx(async (tx) => {
        await f.authRepository.lockAuthorizationGuards(
          [`${actor.id}:${f.sectorId}`],
          tx,
        );
        await f.rows(
          "DELETE FROM public.budget_commercial_permissions WHERE user_id=:id AND operation='DELETE'",
          { id: actor.id },
          tx,
        );
        acquired.release();
        await release.promise;
      });
      await acquired.promise;
      const deleting = remove(row, actor),
        rejected = assert.rejects(deleting, { code: 'forbidden' });
      release.release();
      await revocation;
      await rejected;
      assert.deepEqual(await snapshot(row.id), row);
      const actor2 = await member(['DELETE']),
        repository = Object.create(f.objects);
      repository.lockOwnerObjects = async (...args) => {
        const result = await f.objects.lockOwnerObjects(...args);
        await f.rows(
          "DELETE FROM public.budget_commercial_permissions WHERE user_id=:id AND operation='DELETE'",
          { id: actor2.id },
          args[1],
        );
        return result;
      };
      await assert.rejects(
        remove(
          row,
          actor2,
          new BudgetPdfDeleteService({ ...deps, objects: repository }),
        ),
        { code: 'forbidden' },
      );
      assert.deepEqual(await snapshot(row.id), row);
      await remove(row);
      await drain(row.id);
    },
  );
  await t.test(
    'two cleanup claimers never share a token; actual SIGKILL after physical remove and fresh worker retry converges',
    async () => {
      const row = await make('both');
      await remove(row);
      const batches = await Promise.all([
        f.tx((tx) => f.objects.claimCleanup(tx)),
        f.tx((tx) => f.objects.claimCleanup(tx)),
      ]);
      const jobs = batches.flat();
      assert.equal(new Set(jobs.map((x) => x.id)).size, jobs.length);
      const job = jobs.find((x) => x.owner_budget_id === row.id);
      assert.ok(job);
      const child = fork(
        new URL('../../support/budgets/kill-executor.js', import.meta.url),
        [],
        {
          env: { ...process.env, BUDGETS_KILL_CLAIM: JSON.stringify(job) },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      const exited = once(child, 'exit'),
        timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      try {
        const msg = await Promise.race([
          once(child, 'message').then(([m]) => m),
          exited.then(() => {
            throw Error('KILL_BEFORE_CHECKPOINT');
          }),
        ]);
        assert.equal(msg.event, 'externalDeleteConfirmedBeforeDatabaseCAS');
        assert.equal(await f.storage.stat(job), null);
        child.kill('SIGKILL');
        assert.equal((await exited)[1], 'SIGKILL');
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
      assert.equal((await f.ObjectModel.findByPk(job.id)).state, 'CLEANING');
      await f.rows(
        "UPDATE public.budget_pdf_objects SET lease_until=now()-interval '1 second' WHERE id=:id",
        { id: job.id },
      );
      for (const other of jobs.filter((x) => x.id !== job.id))
        await f.worker.processClaim(other);
      const worker = spawn(
        process.execPath,
        ['tests/support/budgets/run.js', 'worker'],
        {
          env: {
            ...process.env,
            BUDGETS_WORKER_EXECUTION_APPROVED: '1',
            BUDGETS_WORKER_RUN_ONCE: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      worker.stdout.on('data', (x) => (output += x));
      worker.stderr.on('data', (x) => (output += x));
      assert.equal((await once(worker, 'exit'))[0], 0, output);
      assert.equal((await f.ObjectModel.findByPk(job.id)).state, 'REMOVED');
      assert.equal(await f.worker.processClaim(job), 'stale');
      await drain(row.id);
      await absentHttp(row.id);
    },
  );
});
