import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceOrderService } from '../../../src/app/services/ServiceOrderService.js';
import { ServiceOrderProjectionService } from '../../../src/app/services/ServiceOrderProjectionService.js';

function setup({ pending = false, authorized = true, manager = false } = {}) {
  const tx = {};
  const events = [];
  const responsibility = { id: 'r', user_id: 'worker', released_at: null };
  const order = {
    id: 'o',
    sector_id: 's',
    functional_status: 'IN_PRODUCTION',
    administrative_state: 'ACTIVE',
    production_completed: false,
    products: ['a', 'b'].map((id) => ({
      id,
      quantity: 2,
      completed_quantity: 2,
      blocked_quantity: 0,
    })),
    update: async (values, options) => {
      assert.strictEqual(options.transaction, tx);
      Object.assign(order, values);
    },
  };
  const actions = ['a', 'b'].map((id) => ({
    id,
    product_id: id,
    status: id === 'b' && pending ? 'OPEN' : 'APPROVED',
    approved_quantity: id === 'b' && pending ? 0 : 2,
    rejected_quantity: 0,
  }));
  const operations = [];
  const service = new ServiceOrderService({
    database: {
      connection: {
        transaction: async (fn) => {
          const before = { ...order };
          const responsibleBefore = { ...responsibility };
          const count = events.length;
          try {
            return await fn(tx);
          } catch (error) {
            Object.assign(order, before);
            Object.assign(responsibility, responsibleBefore);
            events.length = count;
            throw error;
          }
        },
      },
    },
    orders: {
      findById: async (_id, options) => {
        assert.equal(options.lock, true);
        return order;
      },
      findActiveResponsibility: async () =>
        responsibility.released_at ? null : responsibility,
      releaseResponsibility: async (_r, data, options) => {
        assert.strictEqual(options.transaction, tx);
        responsibility.released_at = new Date();
        responsibility.released_by = data.actorId;
      },
    },
    quality: { getForOrder: async () => actions },
    permissions: {
      hasPermission: async () => manager,
      assertPermission: async (_u, _s, operation) => {
        operations.push(operation);
        if (!authorized)
          throw Object.assign(new Error('forbidden'), {
            code: 'SERVICE_ORDER_FORBIDDEN',
          });
      },
    },
    events: {
      append: async (event, options) => {
        assert.strictEqual(options.transaction, tx);
        events.push(event);
      },
    },
  });
  service.requireCurrentSectorGrant = async () => {};
  return { service, order, actions, events, responsibility, operations };
}
const actor = { id: 'inspector', type: 'user' };
const confirmation = { confirmed: true };

test('closure requires explicit authorized confirmation and every product approved', async () => {
  const { service, order, actions, responsibility, operations } = setup({
    pending: true,
  });
  await assert.rejects(service.closeProduction('o', {}, actor), {
    code: 'explicitConfirmationRequired',
  });
  await assert.rejects(service.closeProduction('o', confirmation, actor), {
    code: 'productionQualityPrerequisiteRequired',
  });
  assert.equal(order.production_completed, false);
  actions[1].approved_quantity = 2;
  actions[1].status = 'APPROVED';
  await service.closeProduction('o', confirmation, actor);
  assert.equal(order.functional_status, 'AWAITING_DELIVERY');
  assert.equal(order.production_completed, true);
  assert.equal(responsibility.released_at, null);
  assert.equal(operations.at(-1), 'RECORD_QUALITY');
  await assert.rejects(service.closeProduction('o', confirmation, actor), {
    code: 'productionClosureNotAllowed',
  });
});

test('selective reinspection approvals are accumulated without counting historical rejections twice', async () => {
  const { service, actions } = setup();
  actions.splice(
    0,
    1,
    {
      id: 'root',
      product_id: 'a',
      status: 'REJECTED',
      approved_quantity: 1,
      rejected_quantity: 1,
    },
    {
      id: 'child',
      parent_quality_id: 'root',
      product_id: 'a',
      status: 'APPROVED',
      approved_quantity: 1,
      rejected_quantity: 0,
    },
  );
  await service.closeProduction('o', confirmation, actor);
});

test('unauthorized users and non-members cannot confirm either command', async () => {
  const { service, order } = setup({ authorized: false });
  await assert.rejects(service.closeProduction('o', confirmation, actor), {
    code: 'SERVICE_ORDER_FORBIDDEN',
  });
  order.functional_status = 'AWAITING_DELIVERY';
  order.production_completed = true;
  await assert.rejects(
    service.complete('o', { ...confirmation, fulfillment: 'DELIVERY' }, actor),
    { code: 'SERVICE_ORDER_FORBIDDEN' },
  );
  service.requireCurrentSectorGrant = async () => {
    throw Object.assign(new Error(), { code: 'sectorGrantRequired' });
  };
  await assert.rejects(
    service.complete('o', { ...confirmation, fulfillment: 'DELIVERY' }, actor),
    { code: 'sectorGrantRequired' },
  );
});

for (const fulfillment of ['DELIVERY', 'INSTALLATION'])
  test(`${fulfillment} is a single terminal confirmation with automatic release`, async () => {
    const { service, order, responsibility, events, operations } = setup();
    await assert.rejects(
      service.complete('o', { ...confirmation, fulfillment }, actor),
      { code: 'completionNotAllowed' },
    );
    await service.closeProduction('o', confirmation, actor);
    await service.complete('o', { ...confirmation, fulfillment }, actor);
    assert.equal(order.functional_status, 'COMPLETED');
    assert.equal(order.administrative_state, 'CLOSED');
    assert.equal(responsibility.released_by, actor.id);
    assert.equal(operations.at(-1), 'CLOSE');
    assert.equal(events.at(-1).payload.fulfillment, fulfillment);
    assert.equal(events.at(-1).actorUserId, actor.id);
    assert.ok(events.at(-1).occurredAt);
    await assert.rejects(
      service.complete('o', { ...confirmation, fulfillment }, actor),
      { code: 'completionNotAllowed' },
    );
    await assert.rejects(service.reopen('o', {}, actor), {
      code: 'operationNotSupported',
    });
    await assert.rejects(service.resume('o', actor), {
      code: 'operationNotSupported',
    });
  });

test('admin and sector manager use the existing authorization policy', async () => {
  const { service, operations } = setup({ authorized: false, manager: true });
  await service.closeProduction('o', confirmation, { ...actor, role: 'admin' });
  await service.complete(
    'o',
    { ...confirmation, fulfillment: 'DELIVERY' },
    actor,
  );
  assert.deepEqual(operations, []);
});

test('final confirmation rechecks quality and rejects invalid or missing confirmation', async () => {
  const { service, actions } = setup();
  await service.closeProduction('o', confirmation, actor);
  await assert.rejects(
    service.complete('o', { fulfillment: 'DELIVERY' }, actor),
    { code: 'explicitConfirmationRequired' },
  );
  await assert.rejects(
    service.complete('o', { ...confirmation, fulfillment: 'BOTH' }, actor),
    { code: 'fulfillmentConfirmationInvalid' },
  );
  actions[0].approved_quantity = 1;
  await assert.rejects(
    service.complete('o', { ...confirmation, fulfillment: 'DELIVERY' }, actor),
    { code: 'productionQualityPrerequisiteRequired' },
  );
});

test('event failures roll back both confirmations and responsibility release', async () => {
  const { service, order, responsibility } = setup();
  const append = service.events.append;
  service.events.append = async () => {
    throw new Error('outbox unavailable');
  };
  await assert.rejects(
    service.closeProduction('o', confirmation, actor),
    /outbox unavailable/,
  );
  assert.equal(order.functional_status, 'IN_PRODUCTION');
  assert.equal(order.production_completed, false);
  service.events.append = append;
  await service.closeProduction('o', confirmation, actor);
  service.events.append = async () => {
    throw new Error('outbox unavailable');
  };
  await assert.rejects(
    service.complete(
      'o',
      { ...confirmation, fulfillment: 'INSTALLATION' },
      actor,
    ),
    /outbox unavailable/,
  );
  assert.equal(order.functional_status, 'AWAITING_DELIVERY');
  assert.equal(responsibility.released_at, null);
});

test('invalid administrative and functional states reject both confirmations without writes', async () => {
  for (const administrativeState of ['SUSPENDED', 'CANCELLED', 'CLOSED']) {
    const { service, order, events } = setup();
    order.administrative_state = administrativeState;
    await assert.rejects(service.closeProduction('o', confirmation, actor), {
      code: 'productionClosureNotAllowed',
    });
    order.functional_status = 'AWAITING_DELIVERY';
    order.production_completed = true;
    await assert.rejects(
      service.complete(
        'o',
        { ...confirmation, fulfillment: 'DELIVERY' },
        actor,
      ),
      { code: 'completionNotAllowed' },
    );
    assert.equal(events.length, 0);
  }
  for (const status of [
    'REGISTERED',
    'AWAITING_SUPPLIER',
    'COMPLETED',
    'CANCELLED',
  ]) {
    const { service, order, events } = setup();
    order.functional_status = status;
    await assert.rejects(service.closeProduction('o', confirmation, actor), {
      code: 'productionClosureNotAllowed',
    });
    await assert.rejects(
      service.complete(
        'o',
        { ...confirmation, fulfillment: 'DELIVERY' },
        actor,
      ),
      { code: 'completionNotAllowed' },
    );
    assert.equal(events.length, 0);
  }
});

test('confirmations require an authenticated user rather than a client identity', async () => {
  const { service } = setup();
  for (const invalidActor of [undefined, { id: 'client', type: 'client' }]) {
    await assert.rejects(
      service.closeProduction('o', confirmation, invalidActor),
      { code: 'authenticatedUserRequired' },
    );
    await assert.rejects(
      service.complete(
        'o',
        { ...confirmation, fulfillment: 'INSTALLATION' },
        invalidActor,
      ),
      { code: 'authenticatedUserRequired' },
    );
  }
});

test('new events replay without replacing historical event meanings', () => {
  const projection = new ServiceOrderProjectionService();
  let state = {
    products: [],
    responsibleUserId: 'worker',
    status: 'IN_PRODUCTION',
    administrativeState: 'ACTIVE',
  };
  state = projection.reduce(state, {
    eventType: 'ServiceOrderProductionCompleted',
    occurredAt: new Date().toISOString(),
    payload: {},
  });
  assert.equal(state.status, 'IN_PRODUCTION');
  state = projection.reduce(state, {
    eventType: 'ServiceOrderProductionClosureConfirmed',
    occurredAt: new Date().toISOString(),
    payload: { confirmedBy: actor.id },
  });
  assert.equal(state.status, 'AWAITING_DELIVERY');
  assert.equal(state.responsibleUserId, 'worker');
  state = projection.reduce(state, {
    eventType: 'ServiceOrderCompletionConfirmed',
    occurredAt: new Date().toISOString(),
    payload: { fulfillment: 'INSTALLATION', confirmedBy: actor.id },
  });
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.responsibleUserId, null);
});
