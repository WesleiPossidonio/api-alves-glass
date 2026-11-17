import assert from 'node:assert/strict';
import test from 'node:test';
import Sequelize from 'sequelize';
import migration from '../../../src/database/migrations/20261126000000-add-service-order-informational-priority.cjs';
import { ServiceOrderService } from '../../../src/app/services/ServiceOrderService.js';
import { ServiceOrderProjectionService } from '../../../src/app/services/ServiceOrderProjectionService.js';
import ServiceOrderRepository from '../../../src/app/repositories/ServiceOrderRepository.js';
import ServiceOrder from '../../../src/app/models/ServiceOrder.js';
import ServiceOrderQualityRepository from '../../../src/app/repositories/ServiceOrderQualityRepository.js';
import ServiceOrderQuality from '../../../src/app/models/ServiceOrderQuality.js';
import { ServiceOrderReadService } from '../../../src/app/services/ServiceOrderReadService.js';

function setup() {
  const tx = {};
  const events = [];
  const order = {
    id: 'o',
    sector_id: 's',
    is_priority: false,
    administrative_state: 'ACTIVE',
    functional_status: 'IN_PRODUCTION',
    queue_entered_at: '2026-11-01',
    update: async (values, options) => {
      assert.strictEqual(options.transaction, tx);
      Object.assign(order, values);
    },
  };
  const service = new ServiceOrderService({
    database: { connection: { transaction: (fn) => fn(tx) } },
    orders: {
      findById: async (_id, options) => {
        assert.equal(options.lock, true);
        return order;
      },
    },
    permissions: {
      hasPermission: async (_id, sector, operation) => {
        assert.equal(sector, 's');
        assert.equal(operation, 'MANAGE_RESPONSIBILITY');
        return true;
      },
    },
    events: {
      append: async (event, options) => {
        assert.strictEqual(options.transaction, tx);
        events.push(event);
      },
    },
  });
  service.requireCurrentSectorGrant = async (_id, sector) =>
    assert.equal(sector, 's');
  return { service, order, events };
}
const manager = { id: 'manager', type: 'user' };

test('priority marking and unmarking records actor, date and previous value without moving the OS', async () => {
  const { service, order, events } = setup();
  for (const priority of [true, false]) {
    const result = await service.setPriority('o', { priority }, manager);
    assert.equal(result.priority, priority);
    assert.equal(order.is_priority, priority);
    assert.equal(order.priority_changed_by, manager.id);
    assert.equal(order.queue_entered_at, '2026-11-01');
    assert.equal(order.functional_status, 'IN_PRODUCTION');
    assert.equal(events.at(-1).payload.previousPriority, !priority);
    assert.equal(events.at(-1).actorUserId, manager.id);
    assert.equal(events.at(-1).occurredAt, result.priorityChangedAt);
  }
  assert.equal(events.length, 2);
  await assert.rejects(service.setPriority('o', { priority: false }, manager), {
    code: 'priorityUnchanged',
  });
  assert.equal(events.length, 2);
});

test('priority requires a boolean, authenticated user, membership and management authority', async () => {
  const { service, events } = setup();
  for (const priority of [undefined, 1, 'true', null])
    await assert.rejects(service.setPriority('o', { priority }, manager), {
      code: 'priorityBooleanRequired',
    });
  await assert.rejects(
    service.setPriority(
      'o',
      { priority: true },
      { id: 'client', type: 'client' },
    ),
    { code: 'authenticatedUserRequired' },
  );
  service.permissions.hasPermission = async () => false;
  await assert.rejects(service.setPriority('o', { priority: true }, manager), {
    code: 'managerPermissionRequired',
  });
  service.requireCurrentSectorGrant = async () => {
    throw Object.assign(new Error(), { code: 'sectorGrantRequired' });
  };
  await assert.rejects(service.setPriority('o', { priority: true }, manager), {
    code: 'sectorGrantRequired',
  });
  await service.setPriority(
    'o',
    { priority: true },
    { ...manager, role: 'admin' },
  );
  assert.equal(events.length, 1);
});

test('terminal OS remain read-only', async () => {
  for (const status of ['COMPLETED', 'CANCELLED']) {
    const { service, order, events } = setup();
    order.functional_status = status;
    await assert.rejects(
      service.setPriority('o', { priority: true }, manager),
      { code: 'orderTerminal' },
    );
    assert.equal(events.length, 0);
  }
});

test('priority projection preserves queue timestamps and historical defaults', () => {
  const projection = new ServiceOrderProjectionService();
  let state = projection.reduce(null, {
    eventType: 'ServiceOrderRegistered',
    aggregateId: 'o',
    occurredAt: '2026-11-01',
    payload: {},
  });
  assert.equal(state.priority, false);
  const queuedAt = state.queuedAt;
  for (const priority of [true, false]) {
    state = projection.reduce(state, {
      eventType: 'ServiceOrderPriorityChanged',
      occurredAt: '2026-11-16',
      payload: { priority, changedBy: 'manager', changedAt: '2026-11-16' },
    });
    assert.equal(state.priority, priority);
    assert.deepEqual(state.queuedAt, queuedAt);
    assert.equal(state.priorityChangedBy, 'manager');
  }
});

test('production and quality repositories retain chronological order without priority sorting', async (t) => {
  t.mock.method(ServiceOrder, 'findAll', async (options) => {
    assert.deepEqual(options.order, [
      ['queue_entered_at', 'ASC'],
      ['id', 'ASC'],
    ]);
    return [];
  });
  t.mock.method(ServiceOrderQuality, 'findAll', async (options) => {
    assert.deepEqual(options.order, [
      ['created_at', 'ASC'],
      ['id', 'ASC'],
    ]);
    return [];
  });
  await ServiceOrderRepository.findQueuePage('s');
  await ServiceOrderQualityRepository.findPendingBySector('s');
});

test('priority migration is additive, transactional and forward-only', async () => {
  const tx = {};
  const columns = [];
  await migration.up(
    {
      sequelize: {
        transaction: (fn) => fn(tx),
        query: async (_sql, options) => {
          assert.strictEqual(options.transaction, tx);
          return [[{ name: '250' }]];
        },
      },
      addColumn: async (table, name, definition, options) => {
        assert.equal(table.tableName, 'service_orders');
        assert.strictEqual(options.transaction, tx);
        columns.push([name, definition]);
      },
    },
    Sequelize,
  );
  assert.deepEqual(
    columns.map(([name]) => name),
    ['is_priority', 'priority_changed_by', 'priority_changed_at'],
  );
  assert.equal(columns[0][1].defaultValue, false);
  await assert.rejects(migration.down(), /Forward-only/);
});

test('internal CQRS queries expose priority with safe defaults for historical projections', async () => {
  const projected = {
    orderId: 'o',
    sectorId: 's',
    clientId: 'c',
    products: [],
    administrativeState: 'ACTIVE',
    readModelVersion: '1',
    priority: true,
    priorityChangedBy: 'manager',
    priorityChangedAt: '2026-11-16T00:00:00Z',
  };
  const read = new ServiceOrderReadService({
    orders: {
      findById: async () => ({
        id: 'o',
        sector_id: 's',
        client_id: 'c',
        operational_version: '1',
      }),
      hasUserSectorGrant: async () => true,
    },
    permissions: { assertPermission: async () => {} },
    connections: {
      getMongoDatabase: async () => ({
        collection: (name) => ({
          findOne: async () =>
            name === 'service_order_projection_control_v1' ? null : projected,
          find: () => ({
            collation() {
              return this;
            },
            sort() {
              return this;
            },
            limit() {
              return this;
            },
            toArray: async () => [],
          }),
        }),
      }),
    },
    projection: new ServiceOrderProjectionService(),
  });
  const marked = await read.getOrder({ orderId: 'o', actor: manager });
  assert.equal(marked.order.priority, true);
  assert.equal(marked.order.priorityChangedBy, 'manager');
  delete projected.priority;
  delete projected.priorityChangedBy;
  delete projected.priorityChangedAt;
  const historical = await read.getOrder({ orderId: 'o', actor: manager });
  assert.equal(historical.order.priority, false);
  assert.equal(historical.order.priorityChangedBy, null);
});
