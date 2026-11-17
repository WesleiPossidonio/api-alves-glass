import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import ReadService from '../../../src/app/services/ServiceOrderReadService.js';
import Projection from '../../../src/app/services/ServiceOrderProjectionService.js';
import auth from '../../../src/app/meddleawares/auth.js';
import {
  requireClient,
  requireUser,
} from '../../../src/app/meddleawares/authorize.js';
import Sessions from '../../../src/app/repositories/AuthSessionRepository.js';
import authConfig from '../../../src/config/auth.js';

function setup() {
  const canonical = {
    id: 'o',
    client_id: 'c',
    sector_id: 's',
    external_number: '000123',
    functional_status: 'IN_PRODUCTION',
    operational_version: '4',
    created_at: new Date(),
  };
  const projected = {
    orderId: 'o',
    clientId: 'c',
    sectorId: 's',
    status: 'IN_PRODUCTION',
    readModelVersion: '4',
    products: [{ movements: [{ actor: 'private' }] }],
    responsibleUserId: 'private',
    priority: true,
    quality: ['private'],
  };
  const service = new ReadService({
    orders: {
      findById: async () => canonical,
      findForClient: async () => [canonical],
    },
    projection: new Projection({ cursorSecret: 'rf31-test-secret' }),
    connections: {
      getMongoDatabase: async () => ({
        collection: (name) => ({
          findOne: async () => (name.includes('control') ? null : projected),
          find: () => ({ toArray: async () => [projected] }),
        }),
      }),
    },
  });
  return { service, canonical, projected };
}
const actor = { id: 'c', type: 'client', role: 'client' };
const list = (service, extra = {}) =>
  service.getClientOrders({ clientId: 'c', actor, ...extra });

test('RF31 allowlist exposes only own identity, textual order number and approved milestone', async () => {
  const { service, canonical, projected } = setup();
  for (const [status, label] of [
    ['REGISTERED', 'Pedido cadastrado'],
    ['AWAITING_SUPPLIER', 'Aguardando fornecedor'],
    ['IN_PRODUCTION', 'Em produção'],
    ['AWAITING_DELIVERY', 'Aguardando entrega/instalação'],
    ['COMPLETED', 'Concluído'],
    ['CANCELLED', 'Cancelado'],
  ]) {
    canonical.functional_status = status;
    projected.status = status;
    assert.deepEqual(await list(service), {
      serviceOrders: [
        { order: { id: 'o', externalNumber: '000123', status: label } },
      ],
      nextCursor: null,
    });
    assert.deepEqual(
      await service.getOrder({ orderId: 'o', actor, client: true }),
      { order: { id: 'o', externalNumber: '000123', status: label } },
    );
  }
});

test('RF31 rejects missing identity, user actor, forged client and cross-client canonical ownership before Mongo', async () => {
  const { service, canonical } = setup();
  for (const invalid of [
    null,
    { type: 'client' },
    { ...actor, type: 'user' },
    { ...actor, id: 'other' },
  ])
    await assert.rejects(list(service, { actor: invalid }), {
      code: 'clientOwnershipRequired',
    });
  canonical.client_id = 'other';
  service.connections.getMongoDatabase = async () =>
    assert.fail('ownership must precede Mongo');
  await assert.rejects(list(service), { code: 'clientOwnershipRequired' });
  await assert.rejects(
    service.getOrder({ orderId: 'o', actor, client: true }),
    { code: 'serviceOrderNotFound' },
  );
});

test('RF31 unknown and historical states fail closed without legacy public status fallback', async () => {
  const { service, canonical, projected } = setup();
  projected.publicStatus = 'IN_PRODUCTION';
  for (const status of [
    'CREATED',
    'APPROVED',
    'MATERIALS_SEPARATED',
    'IN_ROUTE',
    'DELIVERED',
    'UNKNOWN',
    null,
    undefined,
  ]) {
    canonical.functional_status = status;
    await assert.rejects(list(service), {
      code: 'clientStatusMappingPending',
      status: 409,
    });
    await assert.rejects(
      service.getOrder({ orderId: 'o', actor, client: true }),
      { code: 'clientStatusMappingPending', status: 409 },
    );
  }
});

test('RF31 absent projection returns projectionPending without leaking canonical data', async () => {
  const { service } = setup();
  service.connections.getMongoDatabase = async () => ({
    collection: () => ({
      findOne: async () => null,
      find: () => ({ toArray: async () => [] }),
    }),
  });
  await assert.rejects(list(service), {
    code: 'projectionPending',
    status: 503,
  });
  await assert.rejects(
    service.getOrder({ orderId: 'o', actor, client: true }),
    { code: 'projectionPending', status: 503 },
  );
});

test('RF31 stale projection, forged identities and invalid/scoped cursors fail closed', async () => {
  const { service, projected } = setup();
  projected.clientId = 'other';
  await assert.rejects(list(service), { code: 'projectionIdentityMismatch' });
  projected.clientId = 'c';
  projected.readModelVersion = '3';
  await assert.rejects(list(service), { code: 'projectionPending' });
  projected.readModelVersion = '4';
  projected.status = 'AWAITING_SUPPLIER';
  await assert.rejects(list(service), { code: 'projectionPending' });
  await assert.rejects(list(service, { cursor: 'tampered' }), {
    code: 'cursorInvalid',
    status: 400,
  });
  const cursor = service.projection.cursor({
    orderId: 'CLIENT_ORDERS',
    scope: 'other',
    version: '0',
    generation: 'generation-0',
    pageCursor: { createdAt: new Date(), id: 'o' },
  });
  await assert.rejects(list(service, { cursor }), { code: 'cursorInvalid' });
});

test('RF31 existing auth chain requires active client session and denies internal RF32 routes', async () => {
  const previous = Sessions.findActiveById;
  const oldSecret = authConfig.secret;
  authConfig.secret ||= 'rf31-unit-session-secret';
  Sessions.findActiveById = async (sid) =>
    sid === 'active'
      ? {
          actor_type: 'client',
          client_id: 'c',
          expires_at: new Date(Date.now() + 60000),
        }
      : null;
  const app = express();
  app.use((req, _res, next) => {
    req.cookies = req.headers.cookie
      ? { access_token: req.headers.cookie.split('=')[1] }
      : {};
    next();
  });
  app.use(auth);
  const { service } = setup();
  app.get('/service-orders/client/me', requireClient, async (req, res) =>
    res.json(
      await service.getClientOrders({
        clientId: req.userId,
        actor: { id: req.userId, type: req.actorType },
      }),
    ),
  );
  app.get('/service-orders/:id', requireUser, (_req, res) =>
    res.json({ internal: true }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = (path, sid) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      headers: sid
        ? {
            cookie: `access_token=${jwt.sign({ sid, sub: 'c', actor_type: 'client' }, authConfig.secret, { expiresIn: 60 })}`,
          }
        : {},
    });
  try {
    assert.equal((await request('/service-orders/client/me')).status, 401);
    assert.equal(
      (await request('/service-orders/client/me', 'revoked')).status,
      401,
    );
    assert.equal((await request('/service-orders/o', 'active')).status, 403);
    const response = await request(
      '/service-orders/client/me?clientId=other',
      'active',
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      serviceOrders: [
        { order: { id: 'o', externalNumber: '000123', status: 'Em produção' } },
      ],
      nextCursor: null,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Sessions.findActiveById = previous;
    authConfig.secret = oldSecret;
  }
});
