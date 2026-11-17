import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ServiceOrderService } from '../../../src/app/services/ServiceOrderService.js';
import { ServiceOrderProjectionService } from '../../../src/app/services/ServiceOrderProjectionService.js';
import { ServiceOrderOutboxPublisher } from '../../../src/app/services/ServiceOrderOutboxPublisher.js';

test('functional transition event preserves the previous state after instance update', async () => {
  const order = {
    id: 'order',
    sector_id: 'sector',
    functional_status: 'REGISTERED',
    update: async (values) => Object.assign(order, values),
  };
  let recorded;
  const service = new ServiceOrderService({
    database: { connection: { transaction: (fn) => fn({}) } },
    orders: { findById: async () => order },
    events: {
      append: async (event) => {
        recorded = event;
      },
    },
  });
  await service.transitionFunctionalStatus('order', 'IN_PRODUCTION', {
    id: 'admin',
    type: 'user',
    role: 'admin',
  });
  assert.equal(order.functional_status, 'IN_PRODUCTION');
  assert.deepEqual(recorded.payload, {
    previousStatus: 'REGISTERED',
    status: 'IN_PRODUCTION',
  });
});

test('two five-unit assignments keep product total ten in canonical writes, events and projection', async () => {
  const product = {
    id: 'product',
    quantity: 10,
    completed_quantity: 0,
    blocked_quantity: 0,
    specification_revision: 1,
  };
  const assignments = new Map(
    ['a', 'b'].map((id) => [
      id,
      {
        id,
        service_order_id: 'order',
        product_id: 'product',
        assigned_user_id: 'worker',
        status: 'ACTIVE',
        quantity: 5,
        executed_quantity: 0,
      },
    ]),
  );
  const order = {
    id: 'order',
    sector_id: 'sector',
    administrative_state: 'ACTIVE',
    functional_status: 'IN_PRODUCTION',
    products: [product],
  };
  const events = [];
  const service = new ServiceOrderService({
    database: { connection: { transaction: (fn) => fn({}) } },
    orders: {
      findById: async () => order,
      applyProductProgress: async (_id, values) => {
        product.completed_quantity = values.completedQuantity;
      },
    },
    permissions: { assertPermission: async () => {} },
    assignments: {
      findById: async (id) => assignments.get(id),
      recordExecution: async (assignment, { quantity }) => {
        assignment.executed_quantity += quantity;
        return assignment;
      },
    },
    quality: { findActiveForProduct: async () => null },
    events: {
      append: async (event) => {
        events.push(event);
      },
    },
  });
  service.requireCurrentSectorGrant = async () => {};
  const projection = new ServiceOrderProjectionService();
  let projected = {
    products: [
      {
        itemId: 'product',
        quantity: 10,
        completedQuantity: 0,
        assignedQuantity: 10,
      },
    ],
    administrativeState: 'ACTIVE',
  };
  for (const assignmentId of ['a', 'b']) {
    await service.recordExecution(
      { assignmentId, quantity: 5 },
      { id: 'worker', type: 'user' },
    );
    projected = projection.reduce(projected, events.at(-1));
  }
  assert.equal(product.completed_quantity, 10);
  assert.deepEqual(
    events.map((event) => event.payload.assignmentExecutedQuantity),
    [5, 5],
  );
  assert.deepEqual(
    events.map((event) => event.payload.completedQuantity),
    [5, 10],
  );
  assert.equal(projected.products[0].completedQuantity, 10);
});

for (const failure of ['return', 'nack', 'error', 'close', 'declaration']) {
  test(`outbox ${failure} never marks an event published`, async () => {
    const channel = Object.assign(new EventEmitter(), {
      assertExchange: async () => {},
      assertQueue: async () => {
        if (failure === 'declaration') throw new Error('declaration failed');
      },
      bindQueue: async () => {},
      close: async () => {},
      publish: (_exchange, _key, _body, options, callback) => {
        assert.equal(options.mandatory, true);
        setImmediate(() => {
          if (failure === 'return')
            channel.emit('return', {
              properties: { messageId: 'event' },
              fields: { replyText: 'NO_ROUTE' },
            });
          if (failure === 'error')
            channel.emit('error', new Error('channel error'));
          if (failure === 'close') channel.emit('close');
          callback(failure === 'nack' ? new Error('nack') : null);
        });
      },
    });
    const publisher = new ServiceOrderOutboxPublisher({
      database: {},
      connections: {
        getRabbitConnection: async () => ({
          createConfirmChannel: async () => channel,
        }),
      },
    });
    publisher.claim = async () => [
      { event_id: 'event', event_type: 'Registered', payload: {}, attempts: 1 },
    ];
    const failures = [];
    publisher.markFailed = async (row, error) =>
      failures.push([row.event_id, error.message]);
    publisher.markPublished = async () =>
      assert.fail('must not mark published');
    assert.deepEqual(await publisher.publishBatch(), {
      claimed: 1,
      published: 0,
    });
    assert.equal(failures.length, 1);
    assert.equal(channel.listenerCount('return'), 0);
  });
}
