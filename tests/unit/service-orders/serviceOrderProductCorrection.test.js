import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceOrderService } from '../../../src/app/services/ServiceOrderService.js';
import { validateProductMeasurements } from '../../../src/app/services/serviceOrderDomain.js';
import { ServiceOrderProjectionService } from '../../../src/app/services/ServiceOrderProjectionService.js';
import ordersRepository from '../../../src/app/repositories/ServiceOrderRepository.js';

test('RF10 quantity cannot increase or decrease before, during or after production', async () => {
  for (const status of [
    'REGISTERED',
    'AWAITING_SUPPLIER',
    'IN_PRODUCTION',
    'AWAITING_DELIVERY',
    'COMPLETED',
    'CANCELLED',
  ]) {
    for (const quantity of [1, 3]) {
      const { service, order, product, events } = setup();
      order.functional_status = status;
      const before = structuredClone(product);
      let writes = 0;
      service.orders.correctProduct = async () => {
        writes++;
      };
      await assert.rejects(
        service.correctProduct(
          'o',
          'p',
          { expectedVersion: '4', quantity, name: 'Must not change' },
          actor,
        ),
        {
          code:
            status === 'IN_PRODUCTION'
              ? 'productQuantityImmutable'
              : 'productCorrectionNotAllowed',
          status: 409,
        },
      );
      assert.deepEqual(product, before);
      assert.equal(writes, 0);
      assert.equal(events.length, 0);
    }
  }
});

test('RF10 unchanged quantity does not prevent RF09 correction of allowed fields', async () => {
  const { service, product, events } = setup();
  await service.correctProduct(
    'o',
    'p',
    { expectedVersion: '4', quantity: 2, description: 'Corrected' },
    actor,
  );
  assert.equal(product.quantity, 2);
  assert.deepEqual(events[0].payload.newValues, { description: 'Corrected' });
});

test('RF10 repository blocks quantity and composition even when called outside the service', () => {
  const product = {
    update: () => assert.fail('immutable field reached persistence'),
  };
  for (const field of [
    'quantity',
    'id',
    'service_order_id',
    'products',
    'unit_code',
  ])
    assert.throws(
      () =>
        ordersRepository.correctProduct(
          product,
          { [field]: 3 },
          { transaction: {} },
        ),
      /cannot change composition or quantity/,
    );
});

test('legacy revision commands cannot bypass RF10 or replace products', async () => {
  const { service, events } = setup();
  for (const method of [
    'requestSpecificationRevision',
    'decideSpecificationRevision',
  ])
    await assert.rejects(
      service[method](
        'o',
        { productId: 'p', quantity: 3, products: [] },
        actor,
      ),
      { code: 'revisionWorkflowDisabled' },
    );
  assert.equal(events.length, 0);
});

function setup() {
  const events = [];
  const product = {
    id: 'p',
    name: 'Panel',
    description: null,
    quantity: 2,
    measurements: { widthMm: '100', heightMm: '200', finish: 'polished' },
  };
  const order = {
    id: 'o',
    sector_id: 's',
    created_by: 'creator',
    administrative_state: 'ACTIVE',
    functional_status: 'IN_PRODUCTION',
    production_completed: false,
    operational_version: '4',
    products: [product],
  };
  const service = new ServiceOrderService({
    database: { connection: { transaction: (fn) => fn({}) } },
    orders: {
      findById: async () => order,
      correctProduct: async (row, values) => Object.assign(row, values),
    },
    permissions: {
      hasPermission: async () => false,
      assertPermission: async (_u, _s, operation) =>
        assert.equal(operation, 'CREATE'),
    },
    quality: { getForOrder: async () => [] },
    events: { append: async (event) => events.push(event) },
  });
  service.requireCurrentSectorGrant = async () => {};
  return { service, order, product, events };
}
const actor = { id: 'creator', type: 'user' };
const input = { expectedVersion: '4', measurements: { widthMm: '101.25' } };

test('RF07 corrections validate optional specifications and preserve audited historical JSON', async () => {
  const { service, product, events, order } = setup();
  const before = structuredClone(product);
  for (const measurements of [
    { widthMm: 0 },
    { heightMm: -1 },
    { thicknessMm: Infinity },
    { thickness: 'invalid' },
    { glassColor: '' },
    { aluminumColor: 12 },
    { ironColor: null },
  ]) {
    await assert.rejects(
      service.correctProduct(
        'o',
        'p',
        { expectedVersion: '4', measurements },
        actor,
      ),
    );
    assert.deepEqual(product, before);
    assert.equal(events.length, 0);
  }
  const changes = {
    widthMm: '00101.2500',
    thicknessMm: '06.00',
    glassColor: 'Cor livre',
    aluminumColor: 'Acabamento livre',
  };
  await service.correctProduct(
    'o',
    'p',
    { expectedVersion: '4', measurements: changes },
    actor,
  );
  assert.deepEqual(product.measurements, {
    ...before.measurements,
    ...changes,
  });
  assert.deepEqual(
    events[0].payload.previousValues.measurements,
    before.measurements,
  );
  assert.deepEqual(
    events[0].payload.newValues.measurements,
    product.measurements,
  );
  assert.equal(product.quantity, before.quantity);
  assert.equal(product.id, before.id);
  assert.equal(order.products.length, 1);
  assert.equal(events[0].eventType, 'ServiceOrderProductCorrected');
  assert.equal(events[0].payload.correctedBy, actor.id);
  assert.ok(events[0].payload.correctedAt);
});

test('numeric dimensions preserve string/number aliases and reject malformed values', () => {
  for (const measurements of [
    { width: '1.25', height: 2 },
    { widthMm: 1, heightMm: '2e2', profile: {} },
  ])
    assert.equal(validateProductMeasurements(measurements), true);
  for (const value of [
    'abc',
    '',
    'Infinity',
    '0x10',
    Infinity,
    NaN,
    true,
    [],
    null,
  ])
    assert.throws(() =>
      validateProductMeasurements({ width: value, height: 2 }),
    );
});

test('direct correction preserves ID, quantity, composition and extra measurement keys and audits before/after', async () => {
  const { service, product, events, order } = setup();
  await service.correctProduct('o', 'p', input, actor);
  assert.equal(product.id, 'p');
  assert.equal(product.quantity, 2);
  assert.equal(order.products.length, 1);
  assert.deepEqual(product.measurements, {
    widthMm: '101.25',
    heightMm: '200',
    finish: 'polished',
  });
  assert.equal(events[0].payload.previousValues.measurements.widthMm, '100');
  assert.equal(events[0].payload.newValues.measurements.widthMm, '101.25');
  assert.equal(events[0].actorUserId, actor.id);
  assert.ok(events[0].occurredAt);
});

test('only creator with current grant, manager or administrator may correct', async () => {
  const { service } = setup();
  await assert.rejects(
    service.correctProduct('o', 'p', input, { ...actor, id: 'other' }),
    { code: 'productCorrectionForbidden' },
  );
  service.permissions.assertPermission = async () => {
    throw Object.assign(new Error(), { code: 'SERVICE_ORDER_FORBIDDEN' });
  };
  await assert.rejects(service.correctProduct('o', 'p', input, actor), {
    code: 'SERVICE_ORDER_FORBIDDEN',
  });
  service.permissions.hasPermission = async () => true;
  await service.correctProduct('o', 'p', input, { ...actor, id: 'manager' });
  service.requireCurrentSectorGrant = async () => {
    throw Object.assign(new Error(), { code: 'sectorGrantRequired' });
  };
  await assert.rejects(
    service.correctProduct('o', 'p', { ...input, name: 'new' }, actor),
    { code: 'sectorGrantRequired' },
  );
  await service.correctProduct(
    'o',
    'p',
    { expectedVersion: '4', description: 'fixed' },
    { ...actor, role: 'admin' },
  );
});

test('composition, quantity changes and stale writes are rejected', async () => {
  const { service } = setup();
  for (const field of [
    'id',
    'products',
    'unit',
    'completed_quantity',
    'service_order_id',
  ])
    await assert.rejects(
      service.correctProduct(
        'o',
        'p',
        { expectedVersion: '4', [field]: 'x' },
        actor,
      ),
      { code: 'productCorrectionFieldsInvalid' },
    );
  await assert.rejects(
    service.correctProduct('o', 'p', { ...input, quantity: 3 }, actor),
    { code: 'productQuantityImmutable' },
  );
  await assert.rejects(
    service.correctProduct('o', 'p', { ...input, expectedVersion: '3' }, actor),
    { code: 'serviceOrderVersionConflict' },
  );
  await assert.rejects(service.correctProduct('o', 'missing', input, actor), {
    code: 'productNotFound',
  });
});

test('closed, waiting, cancelled and preproduction OS reject correction', async () => {
  for (const state of [
    { administrative_state: 'CLOSED' },
    { administrative_state: 'CANCELLED' },
    { production_completed: true },
  ]) {
    const { service, order } = setup();
    Object.assign(order, state);
    await assert.rejects(service.correctProduct('o', 'p', input, actor), {
      code: 'productCorrectionNotAllowed',
    });
  }
  for (const status of [
    'REGISTERED',
    'AWAITING_SUPPLIER',
    'AWAITING_DELIVERY',
    'COMPLETED',
    'CANCELLED',
  ]) {
    const { service, order, product, events } = setup();
    order.functional_status = status;
    const before = structuredClone(product);
    service.orders.correctProduct = async () =>
      assert.fail('blocked correction reached persistence');
    for (const changes of [
      { name: 'Denied' },
      { description: 'Denied' },
      { measurements: { widthMm: '101' } },
    ])
      await assert.rejects(
        service.correctProduct(
          'o',
          'p',
          { expectedVersion: '4', ...changes },
          actor,
        ),
        {
          code: 'productCorrectionNotAllowed',
        },
      );
    assert.deepEqual(product, before);
    assert.equal(events.length, 0);
  }
});

test('RF11 first quality activity permanently blocks name, description and measurements regardless of outcome', async () => {
  for (const status of ['OPEN', 'APPROVED', 'REJECTED', 'REWORK']) {
    for (const changes of [
      { name: 'Fixed' },
      { description: 'Fixed' },
      { description: null },
      { measurements: { widthMm: '101' } },
    ]) {
      const { service, product, events } = setup();
      product.description = 'Original';
      const before = structuredClone(product);
      service.orders.correctProduct = async () =>
        assert.fail('quality-blocked correction reached persistence');
      service.quality.getForOrder = async () => [
        { product_id: 'p', status, approved_quantity: 0 },
      ];
      await assert.rejects(
        service.correctProduct(
          'o',
          'p',
          { expectedVersion: '4', ...changes },
          actor,
        ),
        { code: 'productCorrectionQualityConflict' },
      );
      assert.deepEqual(product, before);
      assert.equal(events.length, 0);
    }
  }
});

test('RF11 quality of another product does not block a valid audited correction', async () => {
  const { service, product, events } = setup();
  service.quality.getForOrder = async () => [
    { product_id: 'other', status: 'OPEN' },
  ];
  await service.correctProduct(
    'o',
    'p',
    {
      expectedVersion: '4',
      name: 'Fixed',
      description: 'Fixed',
      measurements: { widthMm: '101' },
    },
    actor,
  );
  assert.equal(product.name, 'Fixed');
  assert.equal(product.description, 'Fixed');
  assert.equal(events[0].eventType, 'ServiceOrderProductCorrected');
  assert.equal(events[0].payload.previousValues.name, 'Panel');
  assert.equal(events[0].payload.newValues.name, 'Fixed');
  assert.equal(events[0].payload.correctedBy, actor.id);
  assert.ok(events[0].payload.correctedAt);
});

test('correction replay updates only fields and preserves product composition', () => {
  const projection = new ServiceOrderProjectionService();
  const result = projection.reduce(
    { products: [{ itemId: 'p', quantity: 2, name: 'Panel' }] },
    {
      eventType: 'ServiceOrderProductCorrected',
      productItemId: 'p',
      occurredAt: new Date().toISOString(),
      payload: { newValues: { name: 'Fixed' }, correctedBy: 'creator' },
    },
  );
  assert.equal(result.products[0].name, 'Fixed');
  assert.equal(result.products[0].quantity, 2);
  assert.equal(result.products.length, 1);
});
