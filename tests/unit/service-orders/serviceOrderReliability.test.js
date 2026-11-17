import assert from 'node:assert/strict';
import test from 'node:test';
import ServiceOrderReadService from '../../../src/app/services/ServiceOrderReadService.js';
import {
  ServiceOrderProjectionService,
  SERVICE_ORDER_PROJECTION_COLLECTIONS,
} from '../../../src/app/services/ServiceOrderProjectionService.js';

test('signed movement cursor preserves product and canonical target version', async () => {
  const projection = new ServiceOrderProjectionService({
    connections: {},
    cursorSecret: 'unit-test-cursor-secret',
  });
  const documents = [];
  const movementRows = [
    {
      eventId: 'event-003',
      aggregateVersion: '4',
      productId: 'product-a',
      orderId: 'order-1',
      generation: 'generation-2',
      eventType: 'WorkProgressRecorded',
      occurredAt: '2026-11-13T12:00:03Z',
      payload: { quantity: 1 },
    },
    {
      eventId: 'event-002',
      aggregateVersion: '3',
      productId: 'product-a',
      orderId: 'order-1',
      generation: 'generation-2',
      eventType: 'WorkProgressRecorded',
      occurredAt: '2026-11-13T12:00:02Z',
      payload: { quantity: 1 },
    },
    {
      eventId: 'event-other-product',
      aggregateVersion: '2',
      productId: 'product-b',
      orderId: 'order-1',
      generation: 'generation-2',
      eventType: 'WorkProgressRecorded',
      occurredAt: '2026-11-13T12:00:01Z',
      payload: { quantity: 1 },
    },
  ];
  const collection = (name) => ({
    findOne: async (filter) => {
      if (name === 'service_order_projection_control_v1')
        return { generation: 'generation-2' };
      if (name === SERVICE_ORDER_PROJECTION_COLLECTIONS.orders)
        return {
          orderId: 'order-1',
          generation: 'generation-2',
          clientId: 'client-1',
          sectorId: 'sector-1',
          readModelVersion: '5',
          products: [
            { itemId: 'product-a', name: 'A' },
            { itemId: 'product-b', name: 'B' },
          ],
          publicStatus: 'IN_PRODUCTION',
          administrativeState: 'ACTIVE',
          productionCompleted: false,
        };
      return null;
    },
    find: (filter) => {
      if (name === SERVICE_ORDER_PROJECTION_COLLECTIONS.movements)
        documents.push(filter);
      const rows =
        name === SERVICE_ORDER_PROJECTION_COLLECTIONS.movements
          ? movementRows.filter((row) => {
              if (
                row.orderId !== filter.orderId ||
                row.generation !== filter.generation
              )
                return false;
              if (filter.productId && row.productId !== filter.productId)
                return false;
              if (
                Number(row.aggregateVersion) >
                Number(filter.aggregateVersion.$lte)
              )
                return false;
              if (filter.$or) {
                return (
                  Number(row.aggregateVersion) <
                  Number(filter.$or[1].aggregateVersion.$lt)
                );
              }
              return true;
            })
          : [];
      return {
        collation() {
          return this;
        },
        sort() {
          rows.sort((left, right) => {
            const version =
              Number(right.aggregateVersion) - Number(left.aggregateVersion);
            return version || right.eventId.localeCompare(left.eventId);
          });
          return this;
        },
        limit(count) {
          this.count = count;
          return this;
        },
        toArray: async function () {
          return rows.slice(0, this.count);
        },
      };
    },
  });
  const db = { collection };
  const orders = {
    findById: async () => ({
      id: 'order-1',
      client_id: 'client-1',
      sector_id: 'sector-1',
      operational_version: '7',
    }),
    hasUserSectorGrant: async () => true,
  };
  const service = new ServiceOrderReadService({
    orders,
    permissions: { assertPermission: async () => {} },
    connections: { getMongoDatabase: async () => db },
    projection,
  });

  const first = await service.getOrder({
    orderId: 'order-1',
    actor: { id: 'manager-1', type: 'user', role: 'user' },
    productId: 'product-a',
    limit: 1,
  });
  assert.equal(first.operationalVersion, '7');
  assert.equal(first.readModelVersion, '5');
  assert.deepEqual(
    first.order.products.map((product) => product.itemId),
    ['product-a'],
  );
  assert.ok(first.order.movementsNextCursor);
  assert.equal(documents[0].productId, 'product-a');

  const second = await service.getOrder({
    orderId: 'order-1',
    actor: { id: 'manager-1', type: 'user', role: 'user' },
    cursor: first.order.movementsNextCursor,
    limit: 1,
  });
  assert.equal(second.order.products[0].itemId, 'product-a');
  assert.equal(second.order.products[0].movements[0].eventId, 'event-002');
  assert.equal(documents[1].productId, 'product-a');
});

test('manager read rejects a missing current sector membership before a grant can authorize access', async () => {
  const service = new ServiceOrderReadService({
    orders: {
      findById: async () => ({ id: 'order-1', sector_id: 'sector-1' }),
      hasUserSectorGrant: async () => false,
    },
    permissions: {
      assertPermission: async () =>
        assert.fail('permission checked before membership'),
    },
  });
  await assert.rejects(
    service.getOrder({
      orderId: 'order-1',
      actor: { id: 'manager-1', type: 'user', role: 'user' },
    }),
    { code: 'sectorGrantRequired', status: 403 },
  );
});

test('replay uses a generation-scoped consumer so live idempotency does not suppress rebuild events', async () => {
  const removed = [];
  let failGeneration = false;
  const projection = new ServiceOrderProjectionService({
    generation: 'live',
    connections: {
      getMongoDatabase: async () => ({
        collection: () => ({
          countDocuments: async () => 0,
          findOne: async () => null,
          deleteMany: async (filter) => removed.push(filter),
        }),
      }),
    },
    canonicalVerifier: { verifyGeneration: async () => !failGeneration },
  });
  const event = {
    schemaVersion: 1,
    eventId: 'event-live',
    aggregateType: 'SERVICE_ORDER',
    aggregateId: 'order-1',
    aggregateVersion: '1',
    eventType: 'ServiceOrderRegistered',
    occurredAt: '2026-11-13T12:00:00Z',
    actor: null,
    sectorId: 'sector-1',
    payload: { clientId: 'client-1', externalNumber: '000001' },
  };
  let calls = 0;
  const processedConsumers = [];
  projection.apply = async (received) => {
    calls += 1;
    assert.equal(received.eventId, event.eventId);
    processedConsumers.push(projection.processedConsumer);
    assert.equal(
      projection.processedConsumer?.startsWith(
        'service-order-projection-replay:',
      ),
      true,
    );
    return { status: 'APPLIED', readModelVersion: '1' };
  };
  projection.activateGeneration = async (_db, generation, count) => {
    if (failGeneration) throw new Error('canonical verification failed');
    return { generation, orderCount: count };
  };

  assert.deepEqual(
    await projection.replay([event], {
      generation: 'rebuild-1',
      expectedOrderCount: 1,
    }),
    { generation: 'rebuild-1', orderCount: 1 },
  );
  assert.equal(calls, 1);
  assert.deepEqual(processedConsumers, [
    'service-order-projection-replay:rebuild-1',
  ]);
  assert.equal(projection.generation, 'live');
  assert.equal(projection.processedConsumer, undefined);
  assert.deepEqual(removed, []);

  failGeneration = true;
  await assert.rejects(
    projection.replay([event], {
      generation: 'rebuild-failed',
      expectedOrderCount: 1,
    }),
    /canonical verification failed/,
  );
  assert.equal(projection.generation, 'live');
  assert.equal(projection.processedConsumer, undefined);
  assert.deepEqual(removed, [
    { generation: 'rebuild-failed' },
    { generation: 'rebuild-failed' },
    {
      generation: 'rebuild-failed',
      consumer: 'service-order-projection-replay:rebuild-failed',
    },
  ]);
});
