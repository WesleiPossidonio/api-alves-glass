import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ServiceOrderApplicationError,
  ServiceOrderService,
} from '../../../src/app/services/ServiceOrderService.js';

const setupResponsibilityService = ({
  order,
  active = null,
  userActive = null,
  authorized = true,
  failEvent = false,
} = {}) => {
  const writes = [];
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  const currentOrder = {
    id: 'order-1',
    sector_id: 'sector-1',
    functional_status: 'REGISTERED',
    administrative_state: 'ACTIVE',
    update: async (values) => Object.assign(currentOrder, values),
    ...(order ?? {}),
  };
  let activeResponsibility = active;
  const service = new ServiceOrderService({
    database: { connection: { transaction: (fn) => fn(tx) } },
    orders: {
      lockUserSectorMembership: async () => authorized,
      lockSectorGrant: async () => authorized,
      findBySectorAndExternalNumber: async () => currentOrder,
      findById: async () => currentOrder,
      lockUserResponsibility: async (id) => writes.push(['userLock', id]),
      findActiveResponsibility: async () => activeResponsibility,
      findActiveResponsibilityForUser: async () => userActive,
      assignResponsibility: async ({ orderId, userId, actorId }) => {
        const row = {
          id: `responsibility-${userId}`,
          service_order_id: orderId,
          user_id: userId,
          assigned_by: actorId,
          assigned_at: new Date(),
        };
        activeResponsibility = row;
        writes.push(['assign', row]);
        return row;
      },
      releaseResponsibility: async (row, data) => {
        Object.assign(row, {
          released_by: data.actorId,
          released_at: new Date(),
          release_reason: data.reason,
        });
        activeResponsibility = null;
        writes.push(['release', row]);
      },
    },
    permissions: {
      assertPermission: async () => {
        if (!authorized)
          throw Object.assign(new Error('denied'), {
            code: 'SERVICE_ORDER_FORBIDDEN',
          });
      },
    },
    events: {
      append: async (event) => {
        if (failEvent) throw new Error('event failure');
        writes.push(['event', event]);
      },
    },
    assignments: {},
    quality: {},
  });
  service.requireCurrentSectorGrant = async () => {
    if (!authorized)
      throw new ServiceOrderApplicationError('sectorGrantRequired', 403);
  };
  return {
    service,
    writes,
    getActive: () => activeResponsibility,
    currentOrder,
  };
};

test('responsibility assumption validates sector access, exclusive order/user and active status', async () => {
  const worker = { id: 'worker-1', type: 'user' };
  let context = setupResponsibilityService({ authorized: false });
  await assert.rejects(
    context.service.assumeByExternalNumber(
      { sectorId: 'sector-1', externalNumber: 'TST-1' },
      worker,
    ),
    { code: 'sectorGrantRequired' },
  );
  context = setupResponsibilityService({ active: { user_id: 'worker-2' } });
  await assert.rejects(
    context.service.assumeByExternalNumber(
      { sectorId: 'sector-1', externalNumber: 'TST-1' },
      worker,
    ),
    { code: 'orderAlreadyAssigned' },
  );
  context = setupResponsibilityService({
    userActive: { service_order_id: 'other' },
  });
  await assert.rejects(
    context.service.assumeByExternalNumber(
      { sectorId: 'sector-1', externalNumber: 'TST-1' },
      worker,
    ),
    { code: 'userAlreadyHasActiveOrder' },
  );
  context = setupResponsibilityService({
    order: { functional_status: 'CANCELLED' },
  });
  await assert.rejects(
    context.service.assumeByExternalNumber(
      { sectorId: 'sector-1', externalNumber: 'TST-1' },
      worker,
    ),
    { code: 'orderNotAssumable' },
  );
  context = setupResponsibilityService();
  await context.service.assumeByExternalNumber(
    { sectorId: 'sector-1', externalNumber: 'TST-1' },
    worker,
  );
  await assert.rejects(
    context.service.assumeByExternalNumber(
      { sectorId: 'sector-1', externalNumber: 'TST-1' },
      worker,
    ),
    { code: 'orderAlreadyAssigned' },
  );
  assert.equal(context.writes.filter(([kind]) => kind === 'event').length, 1);
});

test('responsibility release/transfer requires manager permission and preserves release history', async () => {
  const active = { id: 'r1', user_id: 'worker-1' };
  let context = setupResponsibilityService({ active, authorized: false });
  await assert.rejects(
    context.service.releaseResponsibility(
      'order-1',
      {},
      { id: 'manager', type: 'user', role: 'user' },
    ),
    { code: 'sectorGrantRequired' },
  );
  context = setupResponsibilityService({ active: { ...active } });
  const result = await context.service.releaseResponsibility(
    'order-1',
    { nextUserId: 'worker-2', reason: 'handoff' },
    { id: 'manager', type: 'user', role: 'user' },
  );
  assert.equal(result.user_id, 'worker-2');
  assert.equal(context.writes.filter(([kind]) => kind === 'release').length, 1);
  assert.equal(context.writes.filter(([kind]) => kind === 'assign').length, 1);
  assert.equal(context.writes.filter(([kind]) => kind === 'event').length, 2);
  context = setupResponsibilityService({
    active: { ...active },
    userActive: { service_order_id: 'other' },
  });
  await assert.rejects(
    context.service.releaseResponsibility(
      'order-1',
      { nextUserId: 'worker-2' },
      { id: 'manager', type: 'user', role: 'user' },
    ),
    { code: 'userAlreadyHasActiveOrder' },
  );
  assert.equal(context.getActive(), null);
  assert.equal(context.writes.filter(([kind]) => kind === 'assign').length, 0);
});

test('cancellation is authorized, terminal, releases responsibility and rolls back on event failure', async () => {
  const actor = { id: 'manager', type: 'user', role: 'user' };
  for (const reason of [undefined, 'customer request']) {
    const active = { id: 'r1', user_id: 'worker-1' };
    const context = setupResponsibilityService({ active });
    context.service.orders.findActiveResponsibility = async () => active;
    const input = reason ? { reason } : {};
    await context.service.cancel('order-1', input, { ...actor, role: 'admin' });
    assert.equal(context.currentOrder.functional_status, 'CANCELLED');
    assert.equal(context.getActive(), null);
    assert.equal(active.released_by, actor.id);
  }
  let context = setupResponsibilityService({ authorized: false });
  await assert.rejects(context.service.cancel('order-1', {}, actor), {
    code: 'sectorGrantRequired',
  });
  context = setupResponsibilityService({ failEvent: true });
  await assert.rejects(
    context.service.cancel('order-1', {}, { ...actor, role: 'admin' }),
    /event failure/,
  );
  context = setupResponsibilityService({
    order: { functional_status: 'CANCELLED' },
  });
  await assert.rejects(
    context.service.cancel('order-1', {}, { ...actor, role: 'admin' }),
    { code: 'orderTerminal' },
  );
});

test('sector managers may grant only CREATE inside their sector and cannot delegate management', async () => {
  const operations = [];
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  let managerAllowed = true;
  let memberAllowed = true;
  const service = new ServiceOrderService({
    database: {
      connection: { transaction: (callback) => callback(transaction) },
    },
    orders: {
      lockSectorMembership: async () => memberAllowed,
      hasUserSectorGrant: async () => memberAllowed,
    },
    permissions: {
      hasPermission: async (_userId, sectorId, operation) => {
        if (operation === 'MANAGE_RESPONSIBILITY')
          return managerAllowed && sectorId === 'sector-a';
        return false;
      },
      grant: async (grant) => {
        operations.push(grant);
        return grant;
      },
    },
    events: {},
    assignments: {},
    quality: {},
  });
  const manager = { id: 'manager', role: 'user', type: 'user' };
  await service.configurePermission(
    {
      userId: 'worker',
      sectorId: 'sector-a',
      operation: 'CREATE',
      reason: 'authorized creator',
    },
    manager,
  );
  assert.equal(operations.length, 1);
  assert.equal(operations[0].operation, 'CREATE');
  assert.equal(operations[0].actorId, 'manager');
  await assert.rejects(
    service.configurePermission(
      {
        userId: 'worker',
        sectorId: 'sector-a',
        operation: 'CANCEL',
        reason: 'escalation',
      },
      manager,
    ),
    { code: 'managerGrantRestricted' },
  );
  await assert.rejects(
    service.configurePermission(
      {
        userId: 'worker',
        sectorId: 'sector-b',
        operation: 'CREATE',
        reason: 'foreign sector',
      },
      manager,
    ),
    { code: 'managerPermissionRequired' },
  );
  managerAllowed = false;
  await assert.rejects(
    service.configurePermission(
      {
        userId: 'worker',
        sectorId: 'sector-a',
        operation: 'CREATE',
        reason: 'revoked manager',
      },
      manager,
    ),
    { code: 'managerPermissionRequired' },
  );
  memberAllowed = false;
  await assert.rejects(
    service.configurePermission(
      {
        userId: 'worker',
        sectorId: 'sector-a',
        operation: 'CREATE',
        reason: 'not a sector member',
      },
      { id: 'admin', role: 'admin', type: 'user' },
    ),
    { code: 'targetSectorGrantRequired' },
  );
});

test('execution rejects a cancelled, closed or suspended order before writing', async (t) => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  for (const administrativeState of ['CANCELLED', 'CLOSED', 'SUSPENDED']) {
    const calls = [];
    const assignment = {
      id: 'assignment-1',
      service_order_id: 'order-1',
      assigned_user_id: 'worker-1',
      status: 'ACTIVE',
    };
    const service = new ServiceOrderService({
      database: {
        connection: {
          transaction: (callback) => callback(transaction),
        },
      },
      orders: {
        lockSectorGrant: async () => true,
        findById: async () => ({
          id: 'order-1',
          sector_id: 'sector-1',
          administrative_state: administrativeState,
          production_completed: false,
          products: [],
        }),
      },
      assignments: {
        findById: async () => assignment,
        recordExecution: async () => calls.push('execution'),
      },
      permissions: {
        assertPermission: async (...args) =>
          calls.push(['permission', ...args]),
      },
      events: { append: async () => calls.push('event') },
      quality: {},
    });
    service.requireCurrentSectorGrant = async () => true;

    await assert.rejects(
      service.recordExecution(
        { assignmentId: assignment.id, quantity: 1 },
        {
          id: 'worker-1',
          type: 'user',
        },
      ),
      (error) =>
        error instanceof ServiceOrderApplicationError &&
        error.code ===
          (administrativeState === 'CANCELLED'
            ? 'serviceOrderCancelled'
            : 'orderNotActive') &&
        error.status === 409,
    );
    assert.equal(
      calls.some((call) => call === 'execution' || call === 'event'),
      false,
    );
    assert.equal(calls.length, 0);
  }
  t.diagnostic(
    'Every blocked administrative state prevented execution writes.',
  );
});

test('terminal production states reject product correction before persistence', async () => {
  const orderStates = ['CLOSED', 'CANCELLED'];
  for (const administrativeState of orderStates) {
    let writes = 0;
    const service = new ServiceOrderService({
      database: {
        connection: {
          transaction: (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }),
        },
      },
      orders: {
        lockSectorGrant: async () => true,
        findById: async () => ({
          id: 'order-1',
          sector_id: 'sector-1',
          administrative_state: administrativeState,
          production_completed: true,
          products: [{ id: 'product-1' }],
        }),
      },
      assignments: {},
      permissions: {},
      events: { append: async () => writes++ },
      quality: {},
    });
    await assert.rejects(
      service.requestSpecificationRevision(
        'order-1',
        {
          productId: 'product-1',
          measurements: { width: '2', height: '2' },
          reason: 'correction',
        },
        { id: 'user-1', type: 'user' },
      ),
      {
        code: 'revisionWorkflowDisabled',
      },
    );
    assert.equal(writes, 0);
  }
});

test('registration passes the manual number unchanged and uses one transaction for order, products, and events', async () => {
  const transaction = { id: 'tx-registration' };
  const calls = [];
  const service = new ServiceOrderService({
    database: {
      connection: {
        transaction: async (callback) => callback(transaction),
      },
    },
    orders: {
      create: async (data, options) => {
        calls.push(['order-and-products', data, options]);
        return {
          id: 'order-1',
          client_id: data.clientId,
          sector_id: data.sectorId,
          external_number: data.externalNumber,
          due_at: data.dueAt,
          update: async () => {},
          products: [
            {
              id: 'product-1',
              name: 'Painel',
              quantity: 1,
              measurements: { width: '1', height: '1' },
            },
          ],
        };
      },
    },
    events: {
      append: async (event, options) => {
        calls.push(['event', event, options]);
        return { aggregate_version: String(calls.length) };
      },
    },
    permissions: { assertPermission: async () => {} },
    assignments: {},
    quality: {},
  });
  service.requireCurrentSectorGrant = async () => true;

  await service.register(
    {
      clientId: 'client-1',
      sectorId: 'sector-1',
      orderNumber: '000123-A',
      dueAt: '2026-12-01T12:00:00.000Z',
      products: [
        {
          name: 'Painel',
          quantity: 1,
          measurements: { width: '1', height: '1' },
        },
      ],
    },
    { id: 'user-1', type: 'user' },
  );

  assert.equal(calls[0][1].externalNumber, '000123-A');
  assert.strictEqual(calls[0][2].transaction, transaction);
  assert.equal(calls[1][1].eventType, 'ServiceOrderRegistered');
  assert.strictEqual(calls[1][2].transaction, transaction);
  assert.equal(calls[2][1].eventType, 'ServiceOrderProductRegistered');
  assert.strictEqual(calls[2][2].transaction, transaction);
});

test('registration maps the PostgreSQL sector-number constraint violation to conflict', async () => {
  const duplicate = Object.assign(new Error('duplicate'), {
    name: 'SequelizeUniqueConstraintError',
    original: { constraint: 'service_orders_sector_external_number_ckey' },
  });
  const service = new ServiceOrderService({
    database: { connection: { transaction: async (callback) => callback({}) } },
    orders: {
      create: async () => {
        throw duplicate;
      },
    },
    events: {},
    permissions: { assertPermission: async () => {} },
    assignments: {},
    quality: {},
  });
  service.requireCurrentSectorGrant = async () => true;
  await assert.rejects(
    service.register(
      {
        clientId: 'client-1',
        sectorId: 'sector-1',
        externalNumber: '000123',
        dueAt: '2026-12-01T12:00:00.000Z',
        products: [
          {
            name: 'Painel',
            quantity: 1,
            measurements: { width: '1', height: '1' },
          },
        ],
      },
      { id: 'user-1', type: 'user' },
    ),
    { code: 'duplicateServiceOrderNumber', status: 409 },
  );
});

test('quality rejection requires a reason before any persistence write', async () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const writes = [];
  const service = new ServiceOrderService({
    database: {
      connection: { transaction: (callback) => callback(transaction) },
    },
    orders: {
      findById: async () => ({
        id: 'order-1',
        sector_id: 'sector-1',
        administrative_state: 'ACTIVE',
        products: [],
      }),
    },
    assignments: {},
    permissions: { assertPermission: async () => {} },
    events: { append: async () => writes.push('event') },
    quality: {
      findById: async () => ({
        id: 'quality-1',
        service_order_id: 'order-1',
        product_id: 'product-1',
        status: 'OPEN',
        affected_quantity: 2,
        approved_quantity: 0,
        rejected_quantity: 0,
      }),
      findActiveForProductUpdate: async () => ({ id: 'quality-1' }),
    },
  });
  service.requireCurrentSectorGrant = async () => true;
  await assert.rejects(
    service.inspectQuality(
      { qualityId: 'quality-1', quantity: 1, outcome: 'REJECTED' },
      { id: 'inspector-1', type: 'user' },
    ),
    (error) => error.code === 'rejectionReasonRequired',
  );
  assert.deepEqual(writes, []);
});

test('authorized quality inspector may inspect own work without executing old rework workflow', async () => {
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  const calls = [];
  const action = {
    id: 'q-1',
    service_order_id: 'o-1',
    product_id: 'p-1',
    affected_quantity: 2,
    approved_quantity: 0,
    rejected_quantity: 0,
    status: 'OPEN',
  };
  const service = new ServiceOrderService({
    database: { connection: { transaction: (fn) => fn(tx) } },
    orders: {
      findById: async () => ({
        id: 'o-1',
        sector_id: 's-1',
        administrative_state: 'ACTIVE',
        products: [
          {
            id: 'p-1',
            quantity: 2,
            completed_quantity: 2,
            blocked_quantity: 0,
          },
        ],
      }),
      applyProductProgress: async (...args) =>
        calls.push(['progress', ...args]),
    },
    assignments: {},
    permissions: {
      assertPermission: async (_u, _s, operation) => {
        assert.equal(operation, 'RECORD_QUALITY');
      },
    },
    quality: {
      findById: async () => action,
      findActiveForProductUpdate: async () => action,
      recordInspection: async (_a, data) => {
        calls.push(['inspection', data]);
        return { ...action, ...data, approved_quantity: 2 };
      },
      addInspectionHistory: async (_a, entry) => calls.push(['history', entry]),
      getForOrder: async () => [
        { ...action, status: 'APPROVED', approved_quantity: 2 },
      ],
    },
    events: { append: async (event) => calls.push(['event', event.eventType]) },
  });
  service.requireCurrentSectorGrant = async () => true;
  await service.inspectQuality(
    { qualityId: 'q-1', quantity: 2, outcome: 'APPROVED' },
    { id: 'inspector-1', type: 'user' },
  );
  assert.ok(
    calls.some(
      ([kind, event]) =>
        kind === 'event' && event === 'QualityInspectionRecorded',
    ),
  );
  assert.equal(
    calls.some(([kind]) => kind === 'history'),
    false,
  );
});

test('quality signaling isolates products and persists the terminal parent on creation', async () => {
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  const rows = [
    { id: 'other', product_id: 'p-2', status: 'OPEN', rejected_quantity: 0 },
    { id: 'root', product_id: 'p-1', status: 'REJECTED', rejected_quantity: 3 },
    {
      id: 'leaf',
      product_id: 'p-1',
      parent_quality_id: 'root',
      status: 'REJECTED',
      rejected_quantity: 1,
    },
  ];
  const created = [];
  const progress = [];
  const service = new ServiceOrderService({
    database: { connection: { transaction: (fn) => fn(tx) } },
    orders: {
      findById: async () => ({
        id: 'o-1',
        sector_id: 's-1',
        administrative_state: 'ACTIVE',
        products: [
          {
            id: 'p-1',
            quantity: 10,
            completed_quantity: 9,
            blocked_quantity: 1,
          },
          {
            id: 'p-3',
            quantity: 4,
            completed_quantity: 4,
            blocked_quantity: 0,
          },
        ],
      }),
      findActiveResponsibility: async () => ({ user_id: 'worker' }),
      lockProduct: async () => {},
      applyProductProgress: async (id, data) => progress.push([id, data]),
    },
    quality: {
      getForOrder: async () => rows,
      create: async (data, options) => {
        assert.strictEqual(options.transaction, tx);
        created.push(data);
        return { id: 'new', parent_quality_id: data.parentQualityId };
      },
    },
    events: { append: async () => {} },
  });
  service.requireCurrentSectorGrant = async () => true;
  const actor = { id: 'worker', type: 'user' };
  await service.signalProductForInspection(
    { orderId: 'o-1', productId: 'p-1', quantity: 1 },
    actor,
  );
  assert.equal(created[0].parentQualityId, 'leaf');
  assert.deepEqual(progress, [
    ['p-1', { completedQuantity: 10, blockedQuantity: 0 }],
  ]);
  await service.signalProductForInspection(
    { orderId: 'o-1', productId: 'p-3', quantity: 4 },
    actor,
  );
  assert.equal(created[1].parentQualityId, null);
});

test('quality inspection requires the order to be active before authorization or writes', async () => {
  for (const administrativeState of ['CANCELLED', 'CLOSED', 'SUSPENDED']) {
    let permissionCalls = 0;
    const service = new ServiceOrderService({
      database: {
        connection: {
          transaction: (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }),
        },
      },
      orders: {
        findById: async () => ({
          id: 'order-1',
          sector_id: 'sector-1',
          administrative_state: administrativeState,
          products: [],
        }),
      },
      assignments: {},
      permissions: {
        assertPermission: async () => {
          permissionCalls += 1;
        },
      },
      events: {
        getAggregateSummary: async () => assert.fail('must not read events'),
      },
      quality: {
        findById: async () => ({
          service_order_id: 'order-1',
          affected_quantity: 1,
          approved_quantity: 0,
          rejected_quantity: 0,
        }),
      },
    });

    await assert.rejects(
      service.inspectQuality(
        { qualityId: 'quality-1', quantity: 1, outcome: 'APPROVED' },
        { id: 'inspector-1', type: 'user' },
      ),
      (error) =>
        error.status === 409 &&
        error.code ===
          (administrativeState === 'CANCELLED'
            ? 'serviceOrderCancelled'
            : 'orderNotActive'),
    );
    assert.equal(permissionCalls, 0);
  }
});
