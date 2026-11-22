import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import Jwt from 'jsonwebtoken';
import authConfig from '../../../src/config/auth.js';
import AuthSession from '../../../src/app/models/AuthSession.js';
import User from '../../../src/app/models/User.js';
import { csrfTokenForSession } from '../../../src/app/services/sessionSecurity.js';
import { matrixFixture } from '../../support/budgets/matrix-fixture.js';
import { BudgetPermissionService } from '../../../src/app/services/BudgetPermissionService.js';
import { BudgetPermissionController } from '../../../src/app/controllers/BudgetPermissionController.js';
import { createBudgetPermissionRouter } from '../../../src/app/meddleawares/budgetPdfHttp.js';

test('T057 real PG17 HTTP commercial authority, scope, audit, membership and rollback', async (t) => {
  const f = await matrixFixture();
  f.db.options.define.underscored = true;
  AuthSession.init(f.db);
  User.init(f.db);
  const service = new BudgetPermissionService({
    repository: f.authRepository,
    authorization: f.authorization,
    objects: f.objects,
  });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    '/sectors',
    createBudgetPermissionRouter({
      transport: new BudgetPermissionController({ service }),
    }),
  );
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const sector = f.sectorId,
    outside = await f.sector();
  const manager = await f.user(),
    delegate = await f.user(),
    reader = await f.user(),
    foreign = await f.user();
  for (const id of [manager, delegate, reader])
    await f.rows(
      'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:id,:sector,:admin,now())',
      { id, sector, admin: f.creator },
    );
  await f.rows(
    'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:id,:sector,:admin,now())',
    { id: foreign, sector: outside, admin: f.creator },
  );
  async function session(id, type = 'user') {
    const sid = randomUUID(),
      csrf = csrfTokenForSession(sid);
    await AuthSession.create({
      id: sid,
      actor_type: type,
      user_id: type === 'user' ? id : null,
      client_id: type === 'client' ? id : null,
      expires_at: new Date(Date.now() + 600_000),
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
  const admin = await session(f.creator),
    mgr = await session(manager),
    delegated = await session(delegate),
    viewer = await session(reader),
    client = await session(f.clientId, 'client');
  const managerUrl = (id, scope = sector) =>
    `/sectors/${scope}/budget-managers/${id}`;
  const grantUrl = (id, op, scope = sector) =>
    `/sectors/${scope}/budget-permissions/${id}/${op}`;
  const listUrl = (scope = sector) => `/sectors/${scope}/budget-permissions`;
  async function request(method, path, actor, body) {
    const result = await fetch(base + path, {
      method,
      headers: {
        ...actor,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: result.status, body: await result.json() };
  }
  const audit = () =>
    f.rows(
      'SELECT * FROM public.budget_commercial_permission_audit WHERE sector_id=:sector ORDER BY occurred_at,id',
      { sector },
    );
  await t.test(
    'admin only appoints managers; no implicit membership, self grant or cross-sector authority',
    async () => {
      assert.equal((await request('GET', listUrl(), {})).status, 401);
      assert.equal((await request('GET', listUrl(), client)).status, 403);
      assert.equal(
        (
          await request(
            'PUT',
            managerUrl(manager),
            { ...admin, origin: undefined },
            {},
          )
        ).body.error.code,
        'csrfFailed',
      );
      assert.equal(
        (
          await request(
            'PUT',
            managerUrl(manager),
            { ...admin, 'x-csrf-token': 'wrong' },
            {},
          )
        ).status,
        403,
      );
      assert.equal(
        (await request('PUT', managerUrl(manager), mgr, {})).status,
        403,
      );
      assert.equal(
        (await request('PUT', managerUrl(foreign), admin, {})).status,
        403,
      );
      assert.equal(
        (await request('PUT', managerUrl(f.creator), admin, {})).body.error
          .code,
        'selfGrantForbidden',
      );
      assert.equal(
        (await request('PUT', grantUrl(f.creator, 'READ'), admin, {})).body
          .error.code,
        'selfGrantForbidden',
      );
      assert.equal(
        (await request('PUT', managerUrl(manager), client, {})).status,
        403,
      );
      const first = await request('PUT', managerUrl(manager), admin, {});
      assert.equal(first.status, 200);
      assert.equal(first.body.changed, true);
      assert.ok(first.body.auditId);
      assert.deepEqual(
        (await request('PUT', managerUrl(manager), admin, {})).body,
        { changed: false, auditId: null },
      );
      assert.equal((await request('GET', listUrl(outside), mgr)).status, 403);
      assert.equal((await request('GET', listUrl(), mgr)).status, 200);
    },
  );
  await t.test(
    'five independent operations and MANAGE_PERMISSIONS without implicit READ',
    async () => {
      assert.equal(
        (
          await request(
            'PUT',
            grantUrl(delegate, 'MANAGE_PERMISSIONS'),
            mgr,
            {},
          )
        ).status,
        403,
      );
      assert.equal(
        (await request('PUT', grantUrl(manager, 'READ'), mgr, {})).body.error
          .code,
        'selfGrantForbidden',
      );
      const grant = await request(
        'PUT',
        grantUrl(delegate, 'MANAGE_PERMISSIONS'),
        admin,
        {},
      );
      assert.equal(grant.status, 200);
      assert.equal(grant.body.changed, true);
      for (const operation of [
        'CREATE_EDIT',
        'READ',
        'REPLACE_PDF',
        'PUBLISH',
        'DELETE',
      ]) {
        assert.equal(
          (await request('PUT', grantUrl(reader, operation), delegated, {}))
            .status,
          200,
        );
      }
      assert.equal(
        (await request('PUT', managerUrl(reader), delegated, {})).status,
        403,
      );
      assert.equal(
        (await request('PUT', grantUrl(delegate, 'READ'), delegated, {})).body
          .error.code,
        'selfGrantForbidden',
      );
      assert.equal(
        (await request('PUT', grantUrl(manager, 'READ'), delegated, {})).status,
        403,
      );
      const listed = await request('GET', listUrl(), delegated);
      assert.equal(listed.status, 200);
      assert.equal(
        listed.body.permissions.filter((x) => x.userId === reader).length,
        5,
      );
      assert.ok(
        !listed.body.permissions.some(
          (x) => x.userId === delegate && x.operation === 'READ',
        ),
      );
      assert.equal((await request('GET', listUrl(), viewer)).status, 403);
      assert.equal(
        (await request('PUT', grantUrl(reader, 'BAD'), admin, {})).status,
        400,
      );
      assert.equal(
        (
          await request('PUT', grantUrl(reader, 'READ'), admin, {
            role: 'admin',
          })
        ).status,
        400,
      );
      assert.equal(
        (await request('PUT', grantUrl(foreign, 'READ'), mgr, {})).status,
        403,
      );
      assert.equal(
        (await request('PUT', grantUrl(reader, 'MANAGE_PERMISSIONS'), mgr, {}))
          .status,
        403,
      );
      assert.equal(
        (await request('PUT', grantUrl(reader, 'READ', outside), mgr, {}))
          .status,
        403,
      );
    },
  );
  await t.test(
    'revoke is effective immediately, repeat is idempotent, audit rollback is atomic',
    async () => {
      const before = (await audit()).length;
      assert.equal(
        (await request('DELETE', grantUrl(reader, 'READ'), delegated)).body
          .changed,
        true,
      );
      assert.deepEqual(
        (await request('DELETE', grantUrl(reader, 'READ'), delegated)).body,
        { changed: false, auditId: null },
      );
      assert.equal((await audit()).length, before + 1);
      await assert.rejects(
        f.tx((tx) =>
          f.authorization.authorizeOperation(
            { actorId: reader, sectorId: sector, operation: 'READ' },
            tx,
          ),
        ),
        { code: 'forbidden' },
      );
      const oldAppend = f.authRepository.appendAudit;
      f.authRepository.appendAudit = async () => {
        throw Error('AUDIT_FAILURE');
      };
      try {
        assert.equal(
          (await request('PUT', grantUrl(reader, 'READ'), admin, {})).status,
          503,
        );
      } finally {
        f.authRepository.appendAudit = oldAppend;
      }
      assert.equal((await audit()).length, before + 1);
      await assert.rejects(
        f.tx((tx) =>
          f.authorization.authorizeOperation(
            { actorId: reader, sectorId: sector, operation: 'READ' },
            tx,
          ),
        ),
        { code: 'forbidden' },
      );
      assert.equal(
        (await request('PUT', grantUrl(reader, 'READ'), admin, {})).status,
        200,
      );
      await f.rows(
        'DELETE FROM public.user_sectors WHERE user_id=:id AND sector_id=:sector',
        { id: reader, sector },
      );
      await assert.rejects(
        f.tx((tx) =>
          f.authorization.authorizeOperation(
            { actorId: reader, sectorId: sector, operation: 'READ' },
            tx,
          ),
        ),
        { code: 'forbidden' },
      );
      assert.equal(
        (await request('PUT', grantUrl(reader, 'PUBLISH'), delegated, {}))
          .status,
        403,
      );
      assert.equal(
        (await request('GET', listUrl(), admin)).body.permissions.some(
          (x) =>
            x.userId === reader &&
            x.operation === 'READ' &&
            x.effective === false,
        ),
        true,
      );
      // Rejoining the sector makes the existing grant effective again; the
      // management endpoint never creates membership on behalf of the caller.
      await f.rows(
        'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:id,:sector,:admin,now())',
        { id: reader, sector, admin: f.creator },
      );
      await f.tx((tx) =>
        f.authorization.authorizeOperation(
          { actorId: reader, sectorId: sector, operation: 'READ' },
          tx,
        ),
      );
      assert.equal(
        (await request('GET', listUrl(), admin)).body.permissions.some(
          (x) =>
            x.userId === reader &&
            x.operation === 'READ' &&
            x.effective === true,
        ),
        true,
      );
      assert.equal(
        (await request('DELETE', managerUrl(manager), admin)).body.changed,
        true,
      );
      assert.equal((await request('GET', listUrl(), mgr)).status, 403);
      assert.equal(
        (await request('GET', listUrl(), admin)).body.managers.length,
        0,
      );
    },
  );
  await t.test(
    'concurrent grants and revokes are idempotent and audited exactly once per effective transition',
    async () => {
      const candidate = await f.user();
      await f.rows(
        'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:id,:sector,:admin,now())',
        { id: candidate, sector, admin: f.creator },
      );
      const before = (await audit()).length;
      const grants = await Promise.all(
        Array.from({ length: 3 }, () =>
          request('PUT', grantUrl(candidate, 'PUBLISH'), admin, {}),
        ),
      );
      assert.deepEqual(
        grants.map((x) => x.status),
        [200, 200, 200],
      );
      assert.equal(grants.filter((x) => x.body.changed).length, 1);
      const revokes = await Promise.all(
        Array.from({ length: 3 }, () =>
          request('DELETE', grantUrl(candidate, 'PUBLISH'), admin),
        ),
      );
      assert.deepEqual(
        revokes.map((x) => x.status),
        [200, 200, 200],
      );
      assert.equal(revokes.filter((x) => x.body.changed).length, 1);
      const records = (await audit()).slice(before);
      assert.deepEqual(records.map((x) => x.action).sort(), [
        'GRANT',
        'REVOKE',
      ]);
      assert.ok(
        records.every(
          (x) =>
            x.actor_user_id === f.creator &&
            x.target_user_id === candidate &&
            x.sector_id === sector,
        ),
      );
      await assert.rejects(
        f.tx((tx) =>
          f.authRepository.query(
            "UPDATE public.budget_commercial_permission_audit SET action='GRANT' WHERE id=:id RETURNING id",
            { id: records[0].id },
            tx,
          ),
        ),
      );
      assert.equal((await audit()).length, before + 2);
    },
  );
});
