import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import Jwt from 'jsonwebtoken';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { matrixFixture } from '../../support/budgets/matrix-fixture.js';
import AuthSession from '../../../src/app/models/AuthSession.js';
import User from '../../../src/app/models/User.js';
import authConfig from '../../../src/config/auth.js';
import { csrfTokenForSession } from '../../../src/app/services/sessionSecurity.js';
import { createBudgetPdfRouter } from '../../../src/app/meddleawares/budgetPdfHttp.js';
import { createBudgetPdfUpload } from '../../../src/app/meddleawares/budgetPdfUpload.js';
import { BudgetPdfController } from '../../../src/app/controllers/BudgetPdfController.js';
import { BudgetPdfCreateService } from '../../../src/app/services/BudgetPdfCreateService.js';
import { BudgetPdfReadService } from '../../../src/app/services/BudgetPdfReadService.js';
import { BudgetPdfStorageServiceClient } from '../../../src/app/services/BudgetPdfStorageService.js';
import { transportFault } from '../../support/budgets/transport-fault.js';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';
import defaultController from '../../../src/app/controllers/BudgetPdfController.js';

test('T024/T027/T028 real HTTP, real persisted sessions, PG17/MinIO/qpdf', async (t) => {
  const f = await matrixFixture();
  f.db.options.define.underscored = true;
  AuthSession.init(f.db);
  User.init(f.db);
  const common = {
    budgets: f.budgets,
    objects: f.objects,
    authorization: f.authorization,
  };
  const controller = new BudgetPdfController({
    create: new BudgetPdfCreateService({ ...common, storage: f.storage }),
    read: new BudgetPdfReadService({
      ...common,
      cursorSecret: 'http-integration-only-secret-with-32-bytes',
    }),
  });
  let uploads = 0;
  let upload = createBudgetPdfUpload({ timeoutMs: 10000 });
  const app = express();
  app.use(cookieParser());
  app.use(
    '/budgets',
    createBudgetPdfRouter({
      transport: controller,
      multipart: (req, res, next) => {
        uploads++;
        upload(req, res, next);
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const member = await f.user(),
    reader = await f.user(),
    outsider = await f.user();
  for (const id of [member, reader])
    await f.rows(
      'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:id,:sector,:admin,now())',
      { id, sector: f.sectorId, admin: f.creator },
    );
  for (const [id, operation] of [
    [member, 'CREATE_EDIT'],
    [reader, 'READ'],
  ])
    await f.rows(
      'INSERT INTO public.budget_commercial_permissions(user_id,sector_id,operation,granted_by) VALUES (:id,:sector,:operation,:admin)',
      { id, operation, sector: f.sectorId, admin: f.creator },
    );
  async function session(id, type = 'user') {
    const sid = randomUUID(),
      csrf = csrfTokenForSession(sid);
    await AuthSession.create({
      id: sid,
      actor_type: type,
      user_id: type === 'user' ? id : null,
      client_id: type === 'client' ? id : null,
      expires_at: new Date(Date.now() + 60000),
    });
    return {
      sid,
      csrf,
      cookie: `access_token=${Jwt.sign({ sub: id, sid, actor_type: type }, authConfig.secret, { expiresIn: '1m' })}; csrf_token=${csrf}`,
    };
  }
  const admin = await session(f.creator),
    edit = await session(member),
    read = await session(reader),
    outside = await session(outsider),
    client = await session(f.clientId, 'client');
  const fields = {
    sectorId: f.sectorId,
    clientId: f.clientId,
    commercialNumber: '00042',
    administrativeName: 'HTTP synthetic',
    validityDate: '2027-01-01',
  };
  function form(values = fields, bytes = buildPdf(), extraFile = false) {
    const body = new FormData();
    for (const [key, value] of Object.entries(values)) body.append(key, value);
    if (bytes !== null)
      body.append(
        'file',
        new Blob([bytes], { type: 'application/pdf' }),
        'document.pdf',
      );
    if (extraFile) body.append('file', new Blob([buildPdf()]), 'second.pdf');
    return body;
  }
  async function request(path, identity = admin, options = {}) {
    const response = await fetch(url + path, {
      ...options,
      headers: {
        ...(identity
          ? {
              cookie: identity.cookie,
              'x-csrf-token': identity.csrf,
              origin: 'http://localhost',
            }
          : {}),
        ...options.headers,
      },
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  }
  function error(result, status, code) {
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.error.code, code);
    assert.match(result.body.error.requestId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(Object.keys(result.body.error).sort(), [
      'code',
      'message',
      'requestId',
    ]);
  }
  let created;
  try {
    await t.test(
      'actual application route composition exposes only the approved administrative US1 paths',
      async () => {
        const { default: actualApp } = await import('../../../src/app.js');
        const { default: database } = await import(
          '../../../src/database/index.js'
        );
        defaultController.read.cursorSecret =
          'actual-app-test-cursor-secret-at-least-32-bytes';
        const actual = actualApp.listen(0, '127.0.0.1');
        await once(actual, 'listening');
        try {
          const base = `http://127.0.0.1:${actual.address().port}`;
          const blocked = await fetch(base + '/budgets', {
            method: 'POST',
            headers: {
              cookie: admin.cookie,
              origin: 'https://untrusted.invalid',
              'x-csrf-token': admin.csrf,
              'content-type': 'multipart/form-data; boundary=x',
            },
            body: 'malformed',
          });
          assert.equal(blocked.status, 403);
          assert.equal((await blocked.json()).error.code, 'csrfFailed');
          const malformed = await fetch(base + '/budgets', {
            method: 'POST',
            headers: {
              cookie: admin.cookie,
              origin: 'http://localhost',
              'x-csrf-token': admin.csrf,
              'content-type': 'application/json',
            },
            body: '{',
          });
          assert.equal(malformed.status, 400);
          assert.equal((await malformed.json()).error.code, 'invalidInput');
          const response = await fetch(base + '/budgets', {
            method: 'POST',
            headers: {
              cookie: admin.cookie,
              origin: 'http://localhost',
              'x-csrf-token': admin.csrf,
            },
            body: form({ ...fields, commercialNumber: 'app-' + randomUUID() }),
          });
          const body = await response.json();
          assert.equal(response.status, 201, JSON.stringify(body));
          assert.equal(response.headers.get('location'), `/budgets/${body.id}`);
          const detail = await fetch(base + `/budgets/${body.id}`, {
            headers: { cookie: admin.cookie },
          });
          assert.equal(detail.status, 200);
          assert.equal((await detail.json()).published, null);
          // Existing routes keep their session and actor guards in the actual app.
          const check = await fetch(base + '/check-auth', {
            headers: { cookie: admin.cookie },
          });
          assert.equal(check.status, 200);
          assert.equal((await check.json()).userId, f.creator);
          assert.equal(
            (
              await fetch(base + '/sectors', {
                headers: { cookie: admin.cookie },
              })
            ).status,
            200,
          );
          for (const path of ['/client/me', '/user/all']) {
            assert.equal(
              (
                await fetch(base + path, {
                  headers: { cookie: edit.cookie },
                })
              ).status,
              403,
            );
          }
          const legacyDenied = await fetch(base + '/budged', {
            method: 'POST',
            headers: {
              cookie: client.cookie,
              origin: 'http://localhost',
              'x-csrf-token': client.csrf,
            },
          });
          assert.equal(legacyDenied.status, 403);
        } finally {
          actual.closeAllConnections();
          await new Promise((resolve) => actual.close(resolve));
          await database.connection.close();
        }
        // Actual database module initializes shared Model classes; restore this
        // test's already authenticated pool, exactly as app define options do.
        for (const model of [f.Budget, f.ObjectModel]) model.init(f.db);
        const { default: Manager } = await import(
          '../../../src/app/models/BudgetCommercialManager.js'
        );
        const { default: Permission } = await import(
          '../../../src/app/models/BudgetCommercialPermission.js'
        );
        const { default: Audit } = await import(
          '../../../src/app/models/BudgetCommercialPermissionAudit.js'
        );
        for (const model of [Manager, Permission, Audit, AuthSession, User])
          model.init(f.db);
      },
    );
    await t.test(
      'session missing/invalid, CSRF missing/forged, Origin and client rejected before multipart',
      async () => {
        const start = uploads;
        error(
          await request('/budgets', null, {
            method: 'POST',
            body: 'malformed',
            headers: { 'content-type': 'multipart/form-data; boundary=x' },
          }),
          401,
          'sessionInvalid',
        );
        error(
          await request('/budgets', admin, {
            method: 'POST',
            body: 'malformed',
            headers: {
              cookie: 'access_token=invalid; csrf_token=x',
              'x-csrf-token': 'x',
              'content-type': 'multipart/form-data; boundary=x',
            },
          }),
          401,
          'sessionInvalid',
        );
        for (const headers of [
          { 'x-csrf-token': '' },
          { 'x-csrf-token': 'forged' },
          { origin: 'https://untrusted.invalid' },
          { origin: '' },
        ])
          error(
            await request('/budgets', admin, {
              method: 'POST',
              body: 'malformed',
              headers: {
                ...headers,
                'content-type': 'multipart/form-data; boundary=x',
              },
            }),
            403,
            'csrfFailed',
          );
        error(
          await request('/budgets', client, {
            method: 'POST',
            body: 'malformed',
            headers: { 'content-type': 'multipart/form-data; boundary=x' },
          }),
          403,
          'forbidden',
        );
        assert.equal(uploads, start);
        await f.rows(
          'UPDATE public.auth_sessions SET revoked_at=now() WHERE id=:id',
          { id: outside.sid },
        );
        error(
          await request(`/budgets?sectorId=${f.sectorId}`, outside),
          401,
          'sessionInvalid',
        );
      },
    );
    await t.test(
      'valid multipart returns201 minimal body/Location/ETag and remains private',
      async () => {
        created = await request('/budgets', edit, {
          method: 'POST',
          body: form(),
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.deepEqual(Object.keys(created.body).sort(), [
          'id',
          'pendingDocumentId',
          'revision',
        ]);
        assert.equal(created.body.revision, '1');
        assert.equal(
          created.headers.get('location'),
          `/budgets/${created.body.id}`,
        );
        assert.equal(
          created.headers.get('etag'),
          `"budget-${created.body.id}-1"`,
        );
        const row = await f.Budget.findByPk(created.body.id);
        assert.equal(row.created_by, member);
        assert.equal(row.published_object_id, null);
        assert.equal(row.first_published_at, null);
        error(
          await request(`/budgets/${created.body.id}`, edit),
          404,
          'budgetNotFound',
        );
        error(
          await request(`/budgets/${randomUUID()}`, edit),
          404,
          'budgetNotFound',
        );
        error(
          await request('/budgets', read, {
            method: 'POST',
            body: form({ ...fields, commercialNumber: randomUUID() }),
          }),
          403,
          'forbidden',
        );
      },
    );
    await t.test(
      'READ another author, sanitized detail/filters/keyset and exact number',
      async () => {
        const detail = await request(`/budgets/${created.body.id}`, read);
        assert.equal(detail.status, 200);
        assert.equal(detail.body.createdBy, member);
        assert.equal(detail.body.commercialNumber, '00042');
        assert.equal(detail.body.published, null);
        assert.equal(detail.headers.get('etag'), created.headers.get('etag'));
        assert.match(detail.headers.get('cache-control'), /no-store/);
        assert.ok(
          !/bucket|object_key|password|sha256|lease_token/.test(
            JSON.stringify(detail.body),
          ),
        );
        for (const number of ['42', '00043'])
          assert.equal(
            (
              await request('/budgets', admin, {
                method: 'POST',
                body: form({ ...fields, commercialNumber: number }),
              })
            ).status,
            201,
          );
        const exact = await request(
          `/budgets?sectorId=${f.sectorId}&commercialNumber=00042`,
          read,
        );
        assert.equal(exact.status, 200);
        assert.equal(exact.body.items.length, 1);
        const first = await request(
          `/budgets?sectorId=${f.sectorId}&limit=1`,
          read,
        );
        assert.equal(first.body.items.length, 1);
        assert.ok(first.body.nextCursor);
        const second = await request(
          `/budgets?sectorId=${f.sectorId}&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
          read,
        );
        assert.equal(second.status, 200);
        assert.notEqual(second.body.items[0].id, first.body.items[0].id);
        error(
          await request(
            `/budgets?sectorId=${f.sectorId}&commercialNumber=42&cursor=${encodeURIComponent(first.body.nextCursor)}`,
            read,
          ),
          400,
          'invalidCursor',
        );
        error(
          await request(`/budgets?sectorId=${await f.sector()}`, read),
          404,
          'budgetNotFound',
        );
        error(
          await request(`/budgets?sectorId=${f.sectorId}&limit=101`, read),
          400,
          'invalidInput',
        );
        error(
          await request(`/budgets/${created.body.id}?bucket=secret`, read),
          400,
          'invalidInput',
        );
        error(
          await request('/budgets', admin, { method: 'POST', body: form() }),
          409,
          'duplicateNumber',
        );
      },
    );
    await t.test(
      'T029 concurrent HTTP uniqueness and identical text in another sector',
      async () => {
        const commercialNumber = `00042-${randomUUID()}`;
        const results = await Promise.all(
          [0, 1].map(() =>
            request('/budgets', admin, {
              method: 'POST',
              body: form({ ...fields, commercialNumber }),
            }),
          ),
        );
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
        error(
          results.find((r) => r.status === 409),
          409,
          'duplicateNumber',
        );
        const otherSector = await f.sector();
        const other = await request('/budgets', admin, {
          method: 'POST',
          body: form({ ...fields, sectorId: otherSector, commercialNumber }),
        });
        assert.equal(other.status, 201, JSON.stringify(other.body));
        for (const sectorId of [f.sectorId, otherSector]) {
          const page = await request(
            `/budgets?sectorId=${sectorId}&commercialNumber=${commercialNumber}`,
            admin,
          );
          assert.equal(page.status, 200);
          assert.equal(page.body.items.length, 1);
          const detail = await request(
            `/budgets/${page.body.items[0].id}`,
            admin,
          );
          assert.equal(detail.status, 200);
          assert.equal(detail.body.commercialNumber, commercialNumber);
        }
      },
    );
    await t.test(
      'missing/invalid/oversize PDF, duplicate files/fields and unknown actor fields rejected',
      async () => {
        for (const [bytes, status, code] of [
          [null, 422, 'invalidPdf'],
          [Buffer.from('fake'), 415, 'unsupportedMediaType'],
          [Buffer.from('%PDF- malformed'), 422, 'invalidPdf'],
          [buildPdf({ size: 10485761 }), 413, 'fileTooLarge'],
        ])
          error(
            await request('/budgets', admin, {
              method: 'POST',
              body: form({ ...fields, commercialNumber: randomUUID() }, bytes),
            }),
            status,
            code,
          );
        error(
          await request('/budgets', admin, {
            method: 'POST',
            body: form(fields, buildPdf(), true),
          }),
          400,
          'invalidInput',
        );
        for (const values of [
          { ...fields, author: member },
          { ...fields, sectorId: 'invalid' },
          { ...fields, validityDate: '2027-02-29' },
          { ...fields, clientId: randomUUID() },
        ])
          error(
            await request('/budgets', admin, {
              method: 'POST',
              body: form(values),
            }),
            400,
            'invalidInput',
          );
        const duplicate = form();
        duplicate.append('sectorId', f.sectorId);
        error(
          await request('/budgets', admin, { method: 'POST', body: duplicate }),
          400,
          'invalidInput',
        );
        error(
          await request('/budgets', admin, {
            method: 'POST',
            body: '{}',
            headers: { 'content-type': 'application/json' },
          }),
          400,
          'invalidInput',
        );
      },
    );
    await t.test(
      'wire body cap even chunked, upload timeout and client interruption do not persist',
      async () => {
        upload = createBudgetPdfUpload({ timeoutMs: 1000 });
        const before = Number(
          (await f.rows('SELECT count(*) AS n FROM public.budgets_pdf'))[0].n,
        );
        const raw = async (mode) => {
          const req = http.request(url + '/budgets', {
            method: 'POST',
            headers: {
              cookie: admin.cookie,
              origin: 'http://localhost',
              'x-csrf-token': admin.csrf,
              'content-type': 'multipart/form-data; boundary=slow',
            },
          });
          const response = new Promise((resolve, reject) => {
            req.on('response', (res) => {
              let data = '';
              res.on('data', (chunk) => (data += chunk));
              res.on('end', () =>
                resolve({ status: res.statusCode, body: JSON.parse(data) }),
              );
            });
            req.on('error', reject);
          });
          req.write(
            '--slow\r\nContent-Disposition: form-data; name="file"; filename="x.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-',
          );
          if (mode === 'abort') {
            req.destroy();
            await response.catch(() => {});
            return;
          }
          if (mode === 'size') {
            for (let i = 0; i < 12; i++) req.write(Buffer.alloc(1024 * 1024));
            req.end();
          }
          return response;
        };
        error(await raw('size'), 413, 'fileTooLarge');
        error(await raw('timeout'), 503, 'storageUnavailable');
        await raw('abort');
        assert.equal(
          Number(
            (await f.rows('SELECT count(*) AS n FROM public.budgets_pdf'))[0].n,
          ),
          before,
        );
        assert.equal(
          (
            await request('/budgets', admin, {
              method: 'POST',
              body: form({ ...fields, commercialNumber: randomUUID() }),
            })
          ).status,
          201,
        );
        upload = createBudgetPdfUpload({ timeoutMs: 10000 });
      },
    );
    await t.test(
      'exact10MiB is eligible; creator has no implicit READ; grants revoked between requests take effect',
      async () => {
        const response = await request('/budgets', admin, {
          method: 'POST',
          body: form(
            { ...fields, commercialNumber: randomUUID() },
            buildPdf({ size: 10485760 }),
          ),
        });
        assert.equal(response.status, 201, JSON.stringify(response.body));
        const page = await request(
          `/budgets?sectorId=${f.sectorId}&limit=1`,
          read,
        );
        assert.ok(page.body.nextCursor);
        await f.rows(
          "DELETE FROM public.budget_commercial_permissions WHERE user_id=:id AND sector_id=:sector AND operation='READ'",
          { id: reader, sector: f.sectorId },
        );
        error(
          await request(
            `/budgets?sectorId=${f.sectorId}&cursor=${encodeURIComponent(page.body.nextCursor)}`,
            read,
          ),
          404,
          'budgetNotFound',
        );
        for (const id of [created.body.id, randomUUID()])
          error(await request(`/budgets/${id}`, read), 404, 'budgetNotFound');
        await f.rows(
          "INSERT INTO public.budget_commercial_permissions(user_id,sector_id,operation,granted_by) VALUES (:id,:sector,'READ',:admin)",
          { id: reader, sector: f.sectorId, admin: f.creator },
        );
      },
    );
    await t.test(
      'real storage socket failure sanitized through HTTP and durable cleanup; secret config fail closed',
      async () => {
        const proxy = await transportFault(),
          previous = controller.create;
        try {
          controller.create = new BudgetPdfCreateService({
            ...common,
            storage: new BudgetPdfStorageServiceClient({
              client: proxy.client,
              repository: f.objects,
              timeoutMs: 500,
            }),
          });
          const fault = proxy.arm('PUT', 'after');
          const pending = request('/budgets', admin, {
            method: 'POST',
            body: form({ ...fields, commercialNumber: randomUUID() }),
          });
          error(await pending, 503, 'storageUnavailable');
          await fault.hit;
          const orphans = await f.rows(
            "SELECT * FROM public.budget_pdf_objects WHERE created_by=:id AND state='CLEANUP_PENDING'",
            { id: f.creator },
          );
          assert.ok(orphans.length);
          for (const orphan of orphans) {
            assert.equal(await f.Budget.findByPk(orphan.owner_budget_id), null);
          }
        } finally {
          controller.create = previous;
          await proxy.close();
        }
        const previousRead = controller.read;
        controller.read = new BudgetPdfReadService({ ...common });
        error(
          await request(`/budgets?sectorId=${f.sectorId}`, read),
          503,
          'storageUnavailable',
        );
        controller.read = previousRead;
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.db.close();
  }
});
