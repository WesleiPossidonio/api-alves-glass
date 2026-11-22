import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';

test('T054 permission HTTP validates allowlists and delegates only to service', async () => {
  const { BudgetPermissionController } = await import(
    '../../../src/app/controllers/BudgetPermissionController.js'
  );
  const sector = randomUUID(),
    target = randomUUID(),
    actor = randomUUID();
  const service = {
    async change(...args) {
      assert.deepEqual(args, [
        sector,
        target,
        'GRANT',
        'READ',
        { id: actor, type: 'user' },
      ]);
      return { changed: true, auditId: randomUUID() };
    },
  };
  const controller = new BudgetPermissionController({ service });
  const response = {
    locals: {},
    status(code) {
      assert.equal(code, 200);
      return this;
    },
    json(body) {
      assert.equal(body.changed, true);
      assert.ok(body.auditId);
    },
  };
  await controller.change(
    {
      params: { sectorId: sector, userId: target, operation: 'READ' },
      body: {},
      query: {},
      userId: actor,
      actorType: 'user',
      method: 'PUT',
    },
    response,
  );
  let invoked = 0;
  const restricted = new BudgetPermissionController({
    service: {
      async change() {
        invoked++;
      },
    },
  });
  for (const input of [
    {
      params: { sectorId: sector, userId: target, operation: 'unknown' },
      body: {},
      query: {},
      method: 'PUT',
    },
    {
      params: { sectorId: sector, userId: target, operation: 'READ' },
      body: { reason: 'x' },
      query: {},
      method: 'PUT',
    },
    {
      params: { sectorId: sector, userId: target, operation: 'READ' },
      body: {},
      query: { role: 'admin' },
      method: 'PUT',
    },
  ]) {
    let code;
    await restricted.change(
      { ...input, userId: actor, actorType: 'user' },
      {
        locals: {},
        status(n) {
          code = n;
          return this;
        },
        json(body) {
          assert.equal(code, 400);
          assert.equal(body.error.code, 'invalidInput');
        },
      },
    );
  }
  assert.equal(invoked, 0);
});

test('T054 management routes and sector routes coexist with real auth/CSRF middleware', async () => {
  const { createBudgetPermissionRouter } = await import(
    '../../../src/app/meddleawares/budgetPdfHttp.js'
  );
  const router = createBudgetPermissionRouter({
    transport: {
      list(_request, response) {
        response.json({ managers: [], permissions: [] });
      },
      change(_request, response) {
        response.json({ changed: false, auditId: null });
      },
    },
  });
  const patterns = router.stack
    .filter((layer) => layer.route)
    .map((layer) => [Object.keys(layer.route.methods)[0], layer.route.path]);
  assert.deepEqual(patterns, [
    ['get', '/:sectorId/budget-permissions'],
    ['put', '/:sectorId/budget-managers/:userId'],
    ['delete', '/:sectorId/budget-managers/:userId'],
    ['put', '/:sectorId/budget-permissions/:userId/:operation'],
    ['delete', '/:sectorId/budget-permissions/:userId/:operation'],
  ]);
  const request = { path: '/', get: () => undefined };
  let nextArgument;
  router.stack[0].handle(request, {}, (argument) => {
    nextArgument = argument;
  });
  assert.equal(nextArgument, 'router');
});

test('T062 local HTTP: budget permission router yields OS queue and existing sector paths before auth', async () => {
  const { createBudgetPermissionRouter } = await import(
    '../../../src/app/meddleawares/budgetPdfHttp.js'
  );
  const app = express();
  app.use('/sectors', createBudgetPermissionRouter());
  app.use((_request, response, next) => {
    response.set('X-Legacy-Auth', 'reached');
    next();
  });
  app.get('/sectors', (_request, response) => response.json({ sectors: [] }));
  app.get('/sectors/:sectorId/service-orders/queue', (_request, response) =>
    response.json({ data: { orders: [] } }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of [
      '/sectors',
      `/sectors/${randomUUID()}/service-orders/queue`,
    ]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-legacy-auth'), 'reached');
      assert.equal(response.headers.get('cache-control'), null);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
