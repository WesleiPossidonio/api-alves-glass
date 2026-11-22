import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import auth from '../../../src/app/meddleawares/auth.js';
import { requireUser } from '../../../src/app/meddleawares/authorize.js';
import { BudgetPdfReadService } from '../../../src/app/services/BudgetPdfReadService.js';
import {
  budgetEtag,
  createBudgetCursorService,
  publicBudgetError,
} from '../../../src/app/services/BudgetContractService.js';
import { createScenario } from '../../support/budgets/create-scenario.js';
import Jwt from 'jsonwebtoken';
import authConfig from '../../../src/config/auth.js';
import sessions from '../../../src/app/repositories/AuthSessionRepository.js';
import users from '../../../src/app/repositories/UserRepository.js';
import { csrfTokenForSession } from '../../../src/app/services/sessionSecurity.js';
import { BudgetPdfController } from '../../../src/app/controllers/BudgetPdfController.js';

test('T024 actual transport controller minimal201 headers and sanitized envelope (no Models)', async () => {
  const id = randomUUID(),
    document = randomUUID();
  let status = 200,
    body,
    location;
  const headers = {};
  const response = {
    locals: { budgetRequestId: randomUUID() },
    status(code) {
      status = code;
      return this;
    },
    location(value) {
      location = value;
      return this;
    },
    set(name, value) {
      headers[name] = value;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };
  const controller = new BudgetPdfController({
    create: {
      async create(input, actor, bytes, options) {
        assert.equal(actor.id, id);
        assert.equal(actor.type, 'user');
        assert.equal(bytes.toString(), 'PDF');
        assert.ok(options.signal);
        return { id, revision: '1', pendingDocumentId: document };
      },
    },
  });
  await controller.store(
    {
      body: {},
      userId: id,
      actorType: 'user',
      file: { buffer: Buffer.from('PDF') },
      budgetSignal: new AbortController().signal,
    },
    response,
  );
  assert.equal(status, 201);
  assert.equal(location, `/budgets/${id}`);
  assert.equal(headers.ETag, `"budget-${id}-1"`);
  assert.deepEqual(body, { id, revision: '1', pendingDocumentId: document });
  controller.create.create = async () => {
    throw new Error('secret bucket stack');
  };
  await controller.store({ body: {}, userId: id, actorType: 'user' }, response);
  assert.equal(status, 503);
  assert.equal(body.error.code, 'storageUnavailable');
  assert.equal(body.error.requestId, response.locals.budgetRequestId);
  assert.ok(!JSON.stringify(body).includes('secret'));
});

test('T024 transport prerequisite: existing session/Origin/CSRF guards reject before any body access', async () => {
  for (const request of [
    { cookies: {}, method: 'POST', get: () => undefined },
    {
      cookies: { access_token: 'invalid' },
      method: 'POST',
      get: () => undefined,
    },
    {
      cookies: { access_token: 'invalid', csrf_token: 'x' },
      method: 'POST',
      get: (name) => (name === 'origin' ? 'https://untrusted.invalid' : 'x'),
    },
    {
      cookies: { access_token: 'invalid', csrf_token: 'x' },
      method: 'POST',
      get: (name) => (name === 'origin' ? 'http://localhost' : 'x'),
    },
  ]) {
    Object.defineProperty(request, 'body', {
      get() {
        assert.fail('multipart must not be read');
      },
    });
    let status,
      next = false;
    await auth(
      request,
      {
        status(value) {
          status = value;
          return this;
        },
        json() {
          return this;
        },
      },
      () => {
        next = true;
      },
    );
    assert.equal(next, false);
    assert.ok([401, 403].includes(status));
  }
  let next = false;
  requireUser(
    { actorType: 'client' },
    {
      status(code) {
        assert.equal(code, 403);
        return this;
      },
      json() {},
    },
    () => {
      next = true;
    },
  );
  assert.equal(next, false);
});
test('T024 authenticated guard pipeline reaches multipart only after live session, signed CSRF and requireUser', async (t) => {
  const id = randomUUID(),
    sid = randomUUID(),
    csrf = csrfTokenForSession(sid);
  t.mock.method(sessions, 'findActiveById', async () => ({
    user_id: id,
    actor_type: 'user',
    expires_at: new Date(Date.now() + 60000),
  }));
  t.mock.method(users, 'findById', async () => ({ id, role: 'user' }));
  const token = Jwt.sign(
    { sub: id, sid, actor_type: 'user' },
    authConfig.secret,
    { expiresIn: '1m' },
  );
  for (const [csrfHeader, expected] of [
    [csrf, true],
    ['forged', false],
  ]) {
    const order = [],
      request = {
        method: 'POST',
        cookies: { access_token: token, csrf_token: csrfHeader },
        get: (name) => (name === 'origin' ? 'http://localhost' : csrfHeader),
      };
    Object.defineProperty(request, 'body', {
      get() {
        order.push('multipart');
        return {};
      },
    });
    const response = {
      status() {
        return this;
      },
      json() {
        return this;
      },
    };
    await auth(request, response, () => {
      order.push('auth');
      requireUser(request, response, () => {
        order.push('requireUser');
        void request.body;
      });
    });
    assert.deepEqual(
      order,
      expected ? ['auth', 'requireUser', 'multipart'] : [],
    );
    if (expected) assert.equal(request.userId, id);
  }
});

export function readScenario() {
  const actor = { id: randomUUID(), type: 'user' },
    sector = randomUUID(),
    client = randomUUID();
  let permitted = true;
  const calls = [];
  const rows = Array.from({ length: 28 }, (_, i) => ({
    id: randomUUID(),
    sector_id: sector,
    client_id: client,
    commercial_number: i === 0 ? '00042' : String(i),
    administrative_name: 'Synthetic',
    created_by: randomUUID(),
    created_at: new Date('2026-01-01T00:00:00Z'),
    cursor_created_at: '2026-01-01T00:00:00.000000Z',
    updated_at: new Date('2026-01-01T00:00:00Z'),
    revision: '1',
    first_published_at: null,
    published_object_id: null,
    published_validity_date: null,
    pending_object_id: randomUUID(),
    pending_validity_date: '2027-01-01',
    bucket: 'NEVER EXPOSE',
    client: { password_hash: 'NEVER EXPOSE' },
  }));
  const budgets = {
    async findById(id) {
      calls.push('find');
      return rows.find((row) => row.id === id) ?? null;
    },
    async lockBudget(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async listInternal(query) {
      calls.push(query);
      return rows
        .filter(
          (row) =>
            (!query.commercialNumber ||
              row.commercial_number === query.commercialNumber) &&
            (!query.clientId || row.client_id === query.clientId),
        )
        .slice(0, query.limit + 1);
    },
  };
  const authorization = {
    async authorizeOperation(input) {
      calls.push(input);
      if (!permitted) throw { code: 'forbidden' };
    },
  };
  const service = new BudgetPdfReadService({
    budgets,
    objects: { transaction: (work) => work({}) },
    authorization,
    cursors: createBudgetCursorService({
      secret: 'test-only-cursor-secret-at-least-32-bytes',
    }),
  });
  return {
    actor,
    sector,
    client,
    rows,
    calls,
    service,
    revoke() {
      permitted = false;
    },
  };
}
test('T024 POST response contract is minimal even without READ; ETag usable without DTO/client/storage disclosure', async () => {
  const s = createScenario(),
    body = await s.service.create(s.input, s.actor, Buffer.from('%PDF-'));
  assert.deepEqual(Object.keys(body).sort(), [
    'id',
    'pendingDocumentId',
    'revision',
  ]);
  assert.equal(budgetEtag(body.id, body.revision), `"budget-${body.id}-1"`);
  assert.ok(!JSON.stringify(body).includes('private'));
  assert.ok(!JSON.stringify(body).includes(s.input.clientId));
});
test('T024/T026 GET DTO allowlist, private pending only internal, default25/max100, exact filter and cursor scope', async () => {
  const s = readScenario(),
    page = await s.service.list({ sectorId: s.sector }, s.actor);
  assert.equal(page.items.length, 25);
  assert.ok(page.nextCursor);
  assert.ok(!JSON.stringify(page).includes('NEVER EXPOSE'));
  assert.deepEqual(
    Object.keys(page.items[0]).sort(),
    [
      'id',
      'sectorId',
      'clientId',
      'commercialNumber',
      'administrativeName',
      'createdBy',
      'createdAt',
      'updatedAt',
      'revision',
      'firstPublishedAt',
      'published',
      'pending',
    ].sort(),
  );
  assert.equal(page.items[0].published, null);
  assert.equal(page.items[0].pending.documentId, s.rows[0].pending_object_id);
  assert.equal(
    (
      await s.service.list(
        { sectorId: s.sector, commercialNumber: '00042' },
        s.actor,
      )
    ).items.length,
    1,
  );
  assert.equal(
    (
      await s.service.list(
        { sectorId: s.sector, commercialNumber: '42' },
        s.actor,
      )
    ).items.length,
    0,
  );
  assert.equal(
    (await s.service.list({ sectorId: s.sector, limit: '100' }, s.actor)).items
      .length,
    28,
  );
  for (const query of [
    { sectorId: s.sector, limit: '101' },
    { sectorId: s.sector, author: s.actor.id },
    { sectorId: s.sector, clientId: 'invalid' },
    {},
  ])
    await assert.rejects(s.service.list(query, s.actor), {
      code: 'validation',
    });
  await s.service.list(
    { sectorId: s.sector, cursor: page.nextCursor },
    s.actor,
  );
  assert.ok(s.calls.some((call) => call.position));
  for (const query of [
    { sectorId: randomUUID(), cursor: page.nextCursor },
    { sectorId: s.sector, commercialNumber: '00042', cursor: page.nextCursor },
  ])
    await assert.rejects(s.service.list(query, s.actor), {
      code: 'invalidCursor',
    });
});
test('T024/T026 READ revalidated, no creator filter, denied/missing detail indistinguishable; client cannot use internal services', async () => {
  const s = readScenario();
  await s.service.detail(s.rows[0].id, s.actor);
  assert.notEqual(s.rows[0].created_by, s.actor.id);
  const page = await s.service.list({ sectorId: s.sector }, s.actor);
  s.revoke();
  for (const id of [s.rows[0].id, randomUUID()])
    await assert.rejects(s.service.detail(id, s.actor), { code: 'notFound' });
  await assert.rejects(
    s.service.list({ sectorId: s.sector, cursor: page.nextCursor }, s.actor),
    { code: 'notFound' },
  );
  await assert.rejects(
    s.service.detail(s.rows[0].id, { id: s.client, type: 'client' }),
    { code: 'forbidden' },
  );
  assert.ok(
    s.calls
      .filter((call) => call.operation)
      .every((call) => call.operation === 'READ'),
  );
});
test('T026 published expiry uses São Paulo civil date; no history or registry metadata', async () => {
  const s = readScenario();
  Object.assign(s.rows[0], {
    published_object_id: randomUUID(),
    published_validity_date: '2026-11-16',
    first_published_at: new Date(),
  });
  s.service.now = () => new Date('2026-11-17T01:00:00Z');
  assert.equal(
    (await s.service.detail(s.rows[0].id, s.actor)).published.expired,
    false,
  );
  s.service.now = () => new Date('2026-11-17T03:00:00Z');
  assert.equal(
    (await s.service.detail(s.rows[0].id, s.actor)).published.expired,
    true,
  );
  assert.equal(
    publicBudgetError(new Error('raw credentials')).body.error,
    'storageUnavailable',
  );
});
test('T026 scope changed between discovery and owner lock fails closed without cross-sector guard inversion', async () => {
  const s = readScenario();
  s.service.budgets.lockBudget = async () => ({
    ...s.rows[0],
    sector_id: randomUUID(),
  });
  await assert.rejects(s.service.detail(s.rows[0].id, s.actor), {
    code: 'notFound',
  });
  assert.equal(s.calls.filter((call) => call.operation === 'READ').length, 1);
});
test('T026 cursor cannot be reused by another actor; client filter and empty list remain scoped', async () => {
  const s = readScenario(),
    page = await s.service.list({ sectorId: s.sector }, s.actor);
  await assert.rejects(
    s.service.list(
      { sectorId: s.sector, cursor: page.nextCursor },
      { id: randomUUID(), type: 'user' },
    ),
    { code: 'invalidCursor' },
  );
  assert.deepEqual(
    await s.service.list(
      { sectorId: s.sector, clientId: randomUUID() },
      s.actor,
    ),
    { items: [], nextCursor: null },
  );
});
