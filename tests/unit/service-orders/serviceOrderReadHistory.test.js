import assert from 'node:assert/strict';
import test from 'node:test';
import ServiceOrderReadService from '../../../src/app/services/ServiceOrderReadService.js';
import Projection from '../../../src/app/services/ServiceOrderProjectionService.js';

const actor = { id: 'reader', type: 'user' };
function setup() {
  const projected = {
    orderId: 'o',
    sectorId: 's',
    administrativeState: 'ACTIVE',
    status: 'IN_PRODUCTION',
    readModelVersion: '12',
    products: [{ itemId: 'a' }, { itemId: 'b' }],
  };
  let filter;
  let collation;
  const service = new ServiceOrderReadService({
    orders: {
      findById: async () => ({ sector_id: 's', operational_version: '14' }),
      hasUserSectorGrant: async () => true,
    },
    permissions: { assertPermission: async () => {} },
    projection: new Projection({ cursorSecret: 'rf32-unit' }),
    connections: {
      getMongoDatabase: async () => ({
        collection: (name) => ({
          findOne: async () => (name.includes('control') ? null : projected),
          find: (query) => {
            filter = query;
            return {
              collation(value) {
                collation = value;
                return this;
              },
              sort() {
                return this;
              },
              limit() {
                return this;
              },
              toArray: async () => [
                {
                  eventId: '12',
                  aggregateVersion: '12',
                  productId: 'a',
                  eventType: 'ServiceOrderProductCorrected',
                  actor: { id: 'author' },
                  occurredAt: new Date(),
                  payload: {
                    previousValues: { name: 'old' },
                    newValues: { name: 'new' },
                  },
                },
                {
                  eventId: '11',
                  aggregateVersion: '11',
                  productId: 'b',
                  payload: {
                    approvedQuantity: 2,
                    rejectedQuantity: 1,
                    reason: 'edge',
                  },
                },
                {
                  eventId: '10',
                  aggregateVersion: '10',
                  productId: 'a',
                  payload: {},
                },
              ],
            };
          },
        }),
      }),
    },
  });
  return {
    service,
    projected,
    filter: () => filter,
    collation: () => collation,
  };
}

test('RF32 movement details, authorship and pagination remain attached only to their product', async () => {
  const context = setup();
  const result = await context.service.getOrder({
    orderId: 'o',
    actor,
    limit: 2,
  });
  const [a, b] = result.order.products;
  assert.deepEqual(
    a.movements.map((row) => row.eventId),
    ['12'],
  );
  assert.deepEqual(
    b.movements.map((row) => row.eventId),
    ['11'],
  );
  assert.equal(a.movements[0].performedBy, 'author');
  assert.equal(a.movements[0].previousValues.name, 'old');
  assert.equal(b.movements[0].rejectedQuantity, 1);
  assert.equal(b.movements[0].reason, 'edge');
  assert.ok(result.order.movementsNextCursor);
  assert.deepEqual(context.collation(), {
    locale: 'en',
    numericOrdering: true,
  });
  assert.deepEqual(context.filter().productId, { $type: 'string' });
  assert.equal(result.readModelVersion, '12');
});

test('RF32 rejects invalid cursor, unknown product, sector mismatch and impossible projection version', async () => {
  const { service, projected } = setup();
  await assert.rejects(
    service.getOrder({ orderId: 'o', actor, cursor: 'tampered' }),
    { code: 'cursorInvalid', status: 400 },
  );
  await assert.rejects(
    service.getOrder({ orderId: 'o', actor, productId: 'missing' }),
    { code: 'productNotFound' },
  );
  projected.sectorId = 'other';
  await assert.rejects(service.getOrder({ orderId: 'o', actor }), {
    code: 'projectionSectorMismatch',
  });
  projected.sectorId = 's';
  projected.readModelVersion = '15';
  await assert.rejects(service.getOrder({ orderId: 'o', actor }), {
    code: 'projectionAheadOfCanonical',
  });
});

test('RF32 exposes all six functional states without reusing legacy public states', async () => {
  const { service, projected } = setup();
  for (const state of [
    'REGISTERED',
    'AWAITING_SUPPLIER',
    'IN_PRODUCTION',
    'AWAITING_DELIVERY',
    'COMPLETED',
    'CANCELLED',
  ]) {
    projected.status = state;
    assert.equal(
      (await service.getOrder({ orderId: 'o', actor })).order.status,
      state,
    );
  }
});

test('RF32 quality projection applies inspection and approval as distinct facts, without double counting', () => {
  const projection = new Projection();
  let state = {
    products: [{ itemId: 'a', quantity: 2, completedQuantity: 2 }],
  };
  const apply = (eventType, payload) => {
    state = projection.reduce(state, {
      eventType,
      productItemId: 'a',
      aggregateVersion: '1',
      occurredAt: '2026-11-16T00:00:00Z',
      payload,
    });
  };
  apply('QualityInspectionRecorded', {
    approvedQuantity: 2,
    rejectedQuantity: 0,
    status: 'APPROVED',
    completedQuantity: 2,
    blockedQuantity: 0,
  });
  apply('QualityQuantityApproved', { quantity: 2 });
  assert.equal(state.products[0].qualityApprovedQuantity, 2);
  assert.equal(state.products[0].status, 'PRODUCTION_COMPLETED');
  apply('ProductReinspectionSignaled', { blockedQuantity: 1 });
  assert.equal(state.products[0].qualityPending, true);
  assert.equal(state.products[0].status, 'IN_PRODUCTION');
});

test('RF32 authorization is checked before Mongo and administrator does not require individual operation grant', async () => {
  const { service } = setup();
  service.permissions.assertPermission = async () => {
    throw Object.assign(new Error(), { code: 'SERVICE_ORDER_FORBIDDEN' });
  };
  await assert.rejects(service.getOrder({ orderId: 'o', actor }), {
    code: 'SERVICE_ORDER_FORBIDDEN',
  });
  await service.getOrder({ orderId: 'o', actor: { ...actor, role: 'admin' } });
});
