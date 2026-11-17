import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDistributionWithinQuantity,
  assertAssignedExecution,
  assertExecutionWithinAssignment,
  canCompleteProduction,
  cancelServiceOrder,
  createServiceOrderQueueComparator,
  decideSpecificationRevision,
  deriveProductProductionState,
  derivePublicProductionStatus,
  determineProductTriage,
  isDuplicateServiceOrderNumberError,
  orderServiceOrdersByQueue,
  recordQualityInspection,
  reopenClosedOrder,
  requestSpecificationRevision,
  resumeSuspendedOrder,
  transferWorkAssignment,
  transitionPublicServiceOrderStatus,
  ServiceOrderDomainError,
  validateServiceOrderRegistration,
  transitionFunctionalServiceOrder,
} from '../../../src/app/services/serviceOrderDomain.js';

const rejectsWithCode = (fn, code) =>
  assert.throws(
    fn,
    (error) => error instanceof ServiceOrderDomainError && error.code === code,
  );

test('functional service order states permit only approved pre-production moves and block quality-dependent completion', () => {
  assert.equal(
    transitionFunctionalServiceOrder('REGISTERED', 'AWAITING_SUPPLIER'),
    'AWAITING_SUPPLIER',
  );
  assert.equal(
    transitionFunctionalServiceOrder('REGISTERED', 'IN_PRODUCTION'),
    'IN_PRODUCTION',
  );
  assert.equal(
    transitionFunctionalServiceOrder('AWAITING_SUPPLIER', 'IN_PRODUCTION'),
    'IN_PRODUCTION',
  );
  rejectsWithCode(
    () =>
      transitionFunctionalServiceOrder('IN_PRODUCTION', 'AWAITING_SUPPLIER'),
    'functionalStatusTransitionInvalid',
  );
  rejectsWithCode(
    () =>
      transitionFunctionalServiceOrder('IN_PRODUCTION', 'AWAITING_DELIVERY'),
    'functionalStatusTransitionInvalid',
  );
  rejectsWithCode(
    () => transitionFunctionalServiceOrder('AWAITING_DELIVERY', 'COMPLETED'),
    'productionQualityPrerequisiteRequired',
  );
});

test('service order registration validates required header and positive integer products without stock coupling', () => {
  assert.equal(
    validateServiceOrderRegistration({
      clientId: 'client-1',
      sectorId: 'sector-glass',
      externalNumber: '000123',
      dueAt: '2026-12-01T12:00:00.000Z',
      products: [
        {
          name: 'Custom panel',
          quantity: 2,
          unit: 'UN',
          measurements: { widthMm: '1200.5', heightMm: '900', shape: 'oval' },
        },
      ],
    }),
    true,
  );
  rejectsWithCode(
    () =>
      validateServiceOrderRegistration({
        clientId: '',
        sectorId: 's',
        externalNumber: '1',
        dueAt: '2026-12-01',
        products: [{ name: 'x', quantity: 1 }],
      }),
    'clientRequired',
  );
  rejectsWithCode(
    () =>
      validateServiceOrderRegistration({
        clientId: 'c',
        sectorId: '',
        externalNumber: '1',
        dueAt: '2026-12-01',
        products: [{ name: 'x', quantity: 1 }],
      }),
    'sectorRequired',
  );
  rejectsWithCode(
    () =>
      validateServiceOrderRegistration({
        clientId: 'c',
        sectorId: 's',
        externalNumber: '1',
        dueAt: '',
        products: [{ name: 'x', quantity: 1 }],
      }),
    'dueAtRequired',
  );
  rejectsWithCode(
    () =>
      validateServiceOrderRegistration({
        clientId: 'c',
        sectorId: 's',
        externalNumber: '1',
        dueAt: '2026-12-01',
        products: [],
      }),
    'productsRequired',
  );
  rejectsWithCode(
    () =>
      validateServiceOrderRegistration({
        clientId: 'c',
        sectorId: 's',
        externalNumber: '1',
        dueAt: '2026-12-01',
        products: [{ name: 'x', quantity: 1.5 }],
      }),
    'quantityMustBePositiveInteger',
  );
  assert.equal(
    validateServiceOrderRegistration({
      clientId: 'c',
      sectorId: 's',
      externalNumber: 'GL-2026-A',
      dueAt: '2026-12-01',
      products: [
        {
          name: 'x',
          quantity: 1,
          measurements: { width: '100.5', height: '80' },
        },
        {
          name: 'x',
          quantity: 1,
          measurements: { width: '101', height: '80' },
        },
      ],
    }),
    true,
  );
});

test('service order registration preserves flexible precise dimensions per item and optional specifications', () => {
  const products = [
    {
      name: 'Painel sob medida',
      quantity: 1,
      unit: 'UN',
      measurements: {
        widthMm: '1200.125',
        heightMm: '800.005',
        profile: { kind: 'arched', riseMm: '42.75' },
        finish: ['polished', 'edge-sealed'],
      },
    },
    {
      name: 'Painel sob medida',
      quantity: 2,
      unit: 'UN',
      measurements: { widthMm: '1200.126', heightMm: '800.005' },
    },
  ];

  assert.equal(
    validateServiceOrderRegistration({
      clientId: 'client-1',
      sectorId: 'sector-glass',
      externalNumber: 'A-100',
      dueAt: '2026-12-01T12:00:00.000Z',
      products,
    }),
    true,
  );
  assert.equal(products[0].measurements.widthMm, '1200.125');
  assert.equal(products[0].measurements.profile.riseMm, '42.75');
  assert.equal(products[0].description, undefined);
  assert.equal(products[1].description, undefined);
  assert.notStrictEqual(products[0].measurements, products[1].measurements);
  assert.equal(
    validateServiceOrderRegistration({
      clientId: 'client-1',
      sectorId: 'sector-glass',
      externalNumber: 'B-100',
      dueAt: '2026-12-01T12:00:00.000Z',
      notes: undefined,
      products: [
        {
          name: 'Item sem especificação complementar',
          quantity: 1,
          measurements: { widthMm: '500.25', heightMm: '300' },
        },
      ],
    }),
    true,
  );
});

test('different products can share the same dimensions without being merged or rejected', () => {
  assert.equal(
    validateServiceOrderRegistration({
      clientId: 'client-1',
      sectorId: 'sector-glass',
      externalNumber: 'C-100',
      dueAt: '2026-12-01',
      products: [
        {
          name: 'Painel A',
          quantity: 1,
          measurements: { widthMm: '100.5', heightMm: '80' },
        },
        {
          name: 'Painel B',
          quantity: 2,
          measurements: { heightMm: '80', widthMm: '100.5' },
        },
      ],
    }),
    true,
  );
});

test('product registration requires two non-empty dimensions without imposing keys or formats', () => {
  const register = (measurements) =>
    validateServiceOrderRegistration({
      clientId: 'client-1',
      sectorId: 'sector-1',
      externalNumber: 'DIMENSIONS-1',
      dueAt: '2026-12-01',
      products: [{ name: 'Painel', quantity: 1, measurements }],
    });

  assert.equal(register({ width: '1200.25', height: '800.5' }), true);
  rejectsWithCode(
    () => register({ width: '1200.25', height: 'not-normalized' }),
    'dimensionMustBeValidNumber',
  );
  rejectsWithCode(() => register({ width: '1200' }), 'widthAndHeightRequired');
  rejectsWithCode(
    () => register({ width: '1200', height: '  ' }),
    'widthAndHeightRequired',
  );
});

test('manual external order number accepts arbitrary text and preserves leading zeroes', () => {
  const input = {
    clientId: 'client-1',
    sectorId: 'sector-glass',
    externalNumber: '000123-A',
    dueAt: '2026-12-01',
    products: [
      {
        name: 'Painel',
        quantity: 1,
        measurements: { width: '1', height: '1' },
      },
    ],
  };
  assert.equal(validateServiceOrderRegistration(input), true);
  assert.equal(input.externalNumber, '000123-A');
  assert.equal(
    validateServiceOrderRegistration({
      ...input,
      externalNumber: undefined,
      orderNumber: '000123-A',
    }),
    true,
  );
  assert.equal(
    validateServiceOrderRegistration({
      ...input,
      externalNumber: '  Pedido 12/A  ',
    }),
    true,
  );
  rejectsWithCode(
    () => validateServiceOrderRegistration({ ...input, externalNumber: '' }),
    'externalNumberRequired',
  );
  rejectsWithCode(
    () =>
      validateServiceOrderRegistration({
        ...input,
        externalNumber: 'x'.repeat(65),
      }),
    'externalNumberRequired',
  );
});

test('duplicate external number maps only the sector-scoped unique constraint', () => {
  assert.equal(
    isDuplicateServiceOrderNumberError({
      name: 'SequelizeUniqueConstraintError',
      original: { constraint: 'service_orders_sector_external_number_ckey' },
    }),
    true,
  );
  assert.equal(
    isDuplicateServiceOrderNumberError({
      name: 'SequelizeUniqueConstraintError',
      original: { constraint: 'some_other_unique_constraint' },
    }),
    false,
  );
});

test('service order registration requires non-empty object dimensions without constraining flexible keys', () => {
  for (const measurements of [null, [], ['500.25'], {}]) {
    rejectsWithCode(
      () =>
        validateServiceOrderRegistration({
          clientId: 'client-1',
          sectorId: 'sector-glass',
          externalNumber: 'X-1',
          dueAt: '2026-12-01',
          products: [{ name: 'Painel', quantity: 1, measurements }],
        }),
      measurements &&
        !Array.isArray(measurements) &&
        Object.keys(measurements).length === 0
        ? 'measurementsRequired'
        : 'measurementsInvalid',
    );
  }
  rejectsWithCode(
    () =>
      validateServiceOrderRegistration({
        clientId: 'client-1',
        sectorId: 'sector-glass',
        externalNumber: 'X-2',
        dueAt: '2026-12-01',
        products: [{ name: 'Painel', quantity: 1 }],
      }),
    'measurementsInvalid',
  );
});

test('triage threshold is per product quantity and allocation does not determine eligibility', () => {
  assert.equal(determineProductTriage(1), 'NORMAL_FLOW');
  assert.equal(determineProductTriage(6), 'NORMAL_FLOW');
  assert.equal(determineProductTriage(7), 'ADMIN_TRIAGE_REQUIRED');
  assert.equal(determineProductTriage(20), 'ADMIN_TRIAGE_REQUIRED');
  assertDistributionWithinQuantity(7, [
    { quantity: 2 },
    { quantity: 2 },
    { quantity: 3 },
  ]);
});

test('FIFO ties use stable ID order and ignore external number', () => {
  const queuedAt = '2026-11-13T12:00:00.000Z';
  const orders = [
    { id: 'os-z', sectorId: 'glass', queuedAt, externalNumber: 'A-1' },
    { id: 'os-a', sectorId: 'glass', queuedAt, externalNumber: '000001' },
  ];
  assert.deepEqual(
    orderServiceOrdersByQueue(orders, 'glass').map(({ id }) => id),
    ['os-a', 'os-z'],
  );
});

test('public status transition rejects skipping milestones and delivery inference', () => {
  assert.equal(
    transitionPublicServiceOrderStatus('CREATED', 'APPROVED'),
    'APPROVED',
  );
  rejectsWithCode(
    () => transitionPublicServiceOrderStatus('CREATED', 'IN_PRODUCTION'),
    'publicStatusTransitionInvalid',
  );
  rejectsWithCode(
    () => transitionPublicServiceOrderStatus('IN_PRODUCTION', 'IN_ROUTE'),
    'publicStatusTransitionInvalid',
  );
  rejectsWithCode(
    () => transitionPublicServiceOrderStatus('CANCELLED', 'APPROVED'),
    'orderAlreadyCancelled',
  );
});

test('distribution and execution quantities cannot exceed available or assigned amounts', () => {
  assert.deepEqual(
    assertDistributionWithinQuantity(10, [{ quantity: 4 }, { quantity: 3 }]),
    { assignedQuantity: 7, remainingQuantity: 3 },
  );
  rejectsWithCode(
    () =>
      assertDistributionWithinQuantity(5, [{ quantity: 3 }, { quantity: 3 }]),
    'allocationExceedsAvailableQuantity',
  );
  rejectsWithCode(
    () => assertDistributionWithinQuantity(5, [{ quantity: 0 }]),
    'allocationQuantityInvalid',
  );
  assert.equal(assertExecutionWithinAssignment(4, 2, 2), 4);
  rejectsWithCode(
    () => assertExecutionWithinAssignment(4, 2, 3),
    'executionExceedsAssignment',
  );
});

test('queue is sector-scoped and FIFO ties never sort by external number', () => {
  const queue = [
    {
      id: 'late',
      sectorId: 'glass',
      queuedAt: '2026-11-13T12:00:00Z',
      externalNumber: '000010',
    },
    {
      id: 'tie-10',
      sectorId: 'glass',
      queuedAt: '2026-11-13T09:00:00Z',
      externalNumber: 'ZZZ',
    },
    {
      id: 'other',
      sectorId: 'wood',
      queuedAt: '2026-11-13T08:00:00Z',
      externalNumber: '000001',
    },
    {
      id: 'tie-2',
      sectorId: 'glass',
      queuedAt: '2026-11-13T09:00:00Z',
      externalNumber: '001',
    },
    {
      id: 'early',
      sectorId: 'glass',
      queuedAt: '2026-11-13T08:00:00Z',
      externalNumber: '000020',
    },
  ];
  assert.deepEqual(
    orderServiceOrdersByQueue(queue, 'glass').map(({ id }) => id),
    ['early', 'tie-10', 'tie-2', 'late'],
  );
  assert.deepEqual(
    orderServiceOrdersByQueue(
      [
        {
          id: 'textual',
          sectorId: 'glass',
          queuedAt: '2026-11-13T09:00:00Z',
          externalNumber: 'not-numeric',
        },
      ],
      'glass',
    ).map(({ id }) => id),
    ['textual'],
  );
  assert.throws(() => createServiceOrderQueueComparator()({}), {
    code: 'queueTimestampInvalid',
  });
});

test('assignments preserve prior authorship and execution is constrained to actor and sector', () => {
  const result = transferWorkAssignment({
    assignment: {
      productId: 'item',
      sectorId: 'glass',
      assignedUserId: 'worker-a',
      assignedBy: 'manager-a',
      quantity: 4,
      remainingQuantity: 3,
      status: 'ACTIVE',
    },
    assignedUserId: 'worker-b',
    quantity: 2,
    actorId: 'manager-b',
    sectorId: 'glass',
  });
  assert.equal(result.previousAssignment.status, 'REASSIGNED');
  assert.equal(result.previousAssignment.assignedBy, 'manager-a');
  assert.equal(result.nextAssignment.assignedBy, 'manager-b');
  assert.equal(
    assertAssignedExecution({
      assignment: {
        assignedUserId: 'worker-b',
        sectorId: 'glass',
        quantity: 2,
        executedQuantity: 1,
        status: 'ACTIVE',
      },
      actorId: 'worker-b',
      sectorId: 'glass',
      quantity: 1,
    }),
    2,
  );
  rejectsWithCode(
    () =>
      assertAssignedExecution({
        assignment: {
          assignedUserId: 'worker-b',
          sectorId: 'glass',
          quantity: 2,
          status: 'ACTIVE',
        },
        actorId: 'worker-a',
        sectorId: 'glass',
        quantity: 1,
      }),
    'assignmentActorMismatch',
  );
});

test('product progress and completion require all quantity and quality checks', () => {
  assert.equal(deriveProductProductionState({ quantity: 3 }), 'QUEUED');
  assert.equal(
    deriveProductProductionState({ quantity: 3, completedQuantity: 1 }),
    'IN_PRODUCTION',
  );
  assert.equal(
    deriveProductProductionState({ quantity: 3, blockedQuantity: 1 }),
    'QUALITY_BLOCKED',
  );
  assert.equal(
    deriveProductProductionState({ quantity: 3, completedQuantity: 3 }),
    'PRODUCTION_COMPLETED',
  );
  assert.equal(
    canCompleteProduction([
      {
        quantity: 1,
        completedQuantity: 1,
        blockedQuantity: 0,
        pendingQuality: 0,
      },
      {
        quantity: 2,
        completedQuantity: 1,
        blockedQuantity: 0,
        pendingQuality: 0,
      },
    ]),
    false,
  );
  assert.equal(
    canCompleteProduction([
      {
        quantity: 1,
        completedQuantity: 1,
        blockedQuantity: 0,
        pendingQuality: 0,
      },
    ]),
    true,
  );
  assert.equal(
    canCompleteProduction([
      {
        quantity: 5,
        completedQuantity: 5,
        blockedQuantity: 0,
        pendingQuality: 0,
      },
      {
        quantity: 3,
        completedQuantity: 2,
        blockedQuantity: 0,
        pendingQuality: 0,
      },
    ]),
    false,
  );
  assert.equal(
    canCompleteProduction([
      {
        quantity: 3,
        completedQuantity: 2,
        blockedQuantity: 0,
        pendingQuality: 0,
      },
    ]),
    false,
  );
  assert.equal(
    canCompleteProduction([
      {
        quantity: 3,
        completedQuantity: 3,
        blockedQuantity: 0,
        pendingQuality: 0,
      },
    ]),
    true,
  );
  for (const invalidProgress of [
    { quantity: 1, completedQuantity: 1, blockedQuantity: 0 },
    {
      quantity: 1,
      completedQuantity: 2,
      blockedQuantity: 0,
      pendingQuality: 0,
    },
    {
      quantity: 1,
      completedQuantity: 0,
      blockedQuantity: 1,
      pendingQuality: -1,
    },
  ]) {
    rejectsWithCode(
      () => canCompleteProduction([invalidProgress]),
      'productProgressInvalid',
    );
  }
  rejectsWithCode(() => canCompleteProduction([]), 'productsRequired');
});

test('rework inspection is partial, auditable, and prevents self-inspection', () => {
  assert.deepEqual(
    recordQualityInspection({
      reworkId: 'rw-1',
      executorId: 'worker-1',
      inspectorId: 'inspector-2',
      quantity: 1,
      remainingQuantity: 2,
      outcome: 'APPROVED',
    }),
    {
      reworkId: 'rw-1',
      inspectorId: 'inspector-2',
      quantity: 1,
      outcome: 'APPROVED',
    },
  );
  assert.deepEqual(
    recordQualityInspection({
      reworkId: 'rw-1',
      executorIds: ['worker-1', 'worker-2'],
      inspectorId: 'inspector-2',
      quantity: 2,
      remainingQuantity: 2,
      outcome: 'REJECTED',
    }),
    {
      reworkId: 'rw-1',
      inspectorId: 'inspector-2',
      quantity: 2,
      outcome: 'REJECTED',
    },
  );
  rejectsWithCode(
    () =>
      recordQualityInspection({
        reworkId: 'rw-1',
        executorId: 'same',
        inspectorId: 'same',
        quantity: 1,
        remainingQuantity: 2,
        outcome: 'APPROVED',
      }),
    'selfInspectionForbidden',
  );
});

test('specification revision is immutable and advances only after approval', () => {
  const pendingMeasurements = { widthMm: '1000.25' };
  const requestedRevision = { measurements: pendingMeasurements };
  const approvedRequest = {
    ...requestedRevision,
    reason: 'Updated approved dimensions',
  };
  assert.equal(
    decideSpecificationRevision({
      currentRevision: 2,
      requestedRevision: approvedRequest,
      decision: 'REJECTED',
      actorId: 'manager',
    }).currentRevision,
    2,
  );
  assert.equal(
    decideSpecificationRevision({
      currentRevision: 2,
      requestedRevision,
      decision: 'REJECTED',
      actorId: 'manager',
    }).status,
    'REJECTED',
  );
  const approved = decideSpecificationRevision({
    currentRevision: 2,
    requestedRevision: approvedRequest,
    decision: 'APPROVED',
    actorId: 'manager',
  });
  assert.equal(approved.revision.number, 3);
  assert.equal(approved.revision.measurements.widthMm, '1000.25');
  assert.equal(approved.previousRevision, 2);
  assert.equal(approved.revision.reason, approvedRequest.reason);
  assert.equal(requestedRevision.number, undefined);
  assert.equal(requestedRevision.measurements.widthMm, '1000.25');
  approved.revision.measurements.widthMm = 'changed-after-approval';
  assert.equal(requestedRevision.measurements.widthMm, '1000.25');
  rejectsWithCode(
    () =>
      decideSpecificationRevision({
        currentRevision: 2,
        requestedRevision: { reason: 'missing dimensions' },
        decision: 'APPROVED',
        actorId: 'manager',
      }),
    'measurementsInvalid',
  );
  rejectsWithCode(
    () =>
      decideSpecificationRevision({
        currentRevision: 2,
        requestedRevision: { measurements: {}, reason: 'empty dimensions' },
        decision: 'APPROVED',
        actorId: 'manager',
      }),
    'measurementsInvalid',
  );
  rejectsWithCode(
    () =>
      decideSpecificationRevision({
        currentRevision: Number.MAX_SAFE_INTEGER,
        requestedRevision: approvedRequest,
        decision: 'APPROVED',
        actorId: 'manager',
      }),
    'revisionInvalid',
  );
  rejectsWithCode(
    () =>
      decideSpecificationRevision({
        currentRevision: Number.MAX_SAFE_INTEGER - 1,
        requestedRevision: approvedRequest,
        decision: 'APPROVED',
        actorId: 'manager',
      }),
    'revisionInvalid',
  );
  rejectsWithCode(
    () =>
      decideSpecificationRevision({
        currentRevision: Number.MAX_SAFE_INTEGER - 1,
        requestedRevision: approvedRequest,
        decision: 'APPROVED',
        actorId: 'manager',
      }),
    'revisionInvalid',
  );
});

test('specification revision request requires and snapshots reason, actor, and dimensions', () => {
  const measurements = { widthMm: '1250.125' };
  const requested = requestSpecificationRevision({
    currentRevision: 3,
    requestedMeasurements: measurements,
    reason: 'Customer approved revised opening',
    actorId: 'requester-1',
  });
  assert.deepEqual(requested, {
    revision: 4,
    status: 'PENDING',
    requestedBy: 'requester-1',
    reason: 'Customer approved revised opening',
    requestedMeasurements: { widthMm: '1250.125' },
  });
  measurements.widthMm = 'mutated-after-request';
  assert.equal(requested.requestedMeasurements.widthMm, '1250.125');
  rejectsWithCode(
    () =>
      requestSpecificationRevision({
        currentRevision: 3,
        requestedMeasurements: {},
        reason: 'reason',
        actorId: 'requester-1',
      }),
    'measurementsInvalid',
  );
  rejectsWithCode(
    () =>
      requestSpecificationRevision({
        currentRevision: 3,
        requestedMeasurements: { widthMm: '1' },
        reason: ' ',
        actorId: 'requester-1',
      }),
    'reasonRequired',
  );
  rejectsWithCode(
    () =>
      requestSpecificationRevision({
        currentRevision: 3,
        requestedMeasurements: { widthMm: '1' },
        reason: 'valid reason',
        actorId: '',
      }),
    'actorRequired',
  );
});

test('public production status keeps administrative precedence and does not infer route or delivery', () => {
  const base = {
    currentPublicStatus: 'APPROVED',
    productStatuses: ['DONE', 'IN_PRODUCTION'],
  };
  assert.equal(
    derivePublicProductionStatus({ ...base, administrativeState: 'ACTIVE' }),
    'IN_PRODUCTION',
  );
  assert.equal(
    derivePublicProductionStatus({
      ...base,
      currentPublicStatus: 'IN_PRODUCTION',
      administrativeState: 'SUSPENDED',
    }),
    'IN_PRODUCTION',
  );
  assert.equal(
    derivePublicProductionStatus({
      ...base,
      currentPublicStatus: 'IN_PRODUCTION',
      administrativeState: 'CLOSED',
    }),
    'IN_PRODUCTION',
  );
  assert.equal(
    derivePublicProductionStatus({ ...base, administrativeState: 'CANCELLED' }),
    'CANCELLED',
  );
});

test('suspension resumes with authorization and blockers checked without creating a cycle', () => {
  assert.deepEqual(resumeSuspendedOrder('SUSPENDED', { authorized: true }), {
    administrativeState: 'ACTIVE',
    createsCycle: false,
  });
  rejectsWithCode(
    () => resumeSuspendedOrder('SUSPENDED', { authorized: false }),
    'forbidden',
  );
  rejectsWithCode(
    () =>
      resumeSuspendedOrder('SUSPENDED', {
        authorized: true,
        blockers: ['quality'],
      }),
    'resumeBlocked',
  );
  rejectsWithCode(
    () => resumeSuspendedOrder('CLOSED', { authorized: true }),
    'orderNotSuspended',
  );
});

test('cancellation is authorized, justified, terminal and cannot be repeated', () => {
  assert.deepEqual(
    cancelServiceOrder('ACTIVE', {
      authorized: true,
      reason: 'Client withdrew request',
    }),
    { administrativeState: 'CANCELLED', terminal: true },
  );
  rejectsWithCode(
    () => cancelServiceOrder('ACTIVE', { authorized: false, reason: 'reason' }),
    'forbidden',
  );
  rejectsWithCode(
    () => cancelServiceOrder('ACTIVE', { authorized: true, reason: 7 }),
    'reasonInvalid',
  );
  rejectsWithCode(
    () =>
      cancelServiceOrder('CANCELLED', { authorized: true, reason: 'again' }),
    'orderAlreadyCancelled',
  );
});

test('reopening only accepts closed orders, requires justification and explicit valid item quantities, and preserves prior cycle history', () => {
  const priorCycles = [{ number: 1, result: 'closed and approved' }];
  const order = {
    administrativeState: 'CLOSED',
    actorId: 'authenticated-manager',
    products: [
      { id: 'item-a', quantity: 5, approvedQuantity: 3 },
      { id: 'item-b', quantity: 2, approvedQuantity: 2 },
    ],
    cycles: priorCycles,
  };
  const result = reopenClosedOrder(order, {
    authorized: true,
    actorId: 'manager',
    actorId: 'authenticated-manager',
    reason: 'Rework requested',
    scope: [{ productId: 'item-a', quantity: 2 }],
  });
  assert.deepEqual(result.cycle, {
    number: 2,
    reason: 'Rework requested',
    reopenedBy: 'authenticated-manager',
    scope: [{ productId: 'item-a', quantity: 2 }],
  });
  assert.strictEqual(result.priorCycles, priorCycles);
  assert.deepEqual(priorCycles, [{ number: 1, result: 'closed and approved' }]);
  rejectsWithCode(
    () =>
      reopenClosedOrder(
        { ...order, administrativeState: 'CANCELLED' },
        {
          authorized: true,
          actorId: 'manager',
          reason: 'x',
          scope: [{ productId: 'item-a', quantity: 1 }],
        },
      ),
    'orderCancelled',
  );
  rejectsWithCode(
    () =>
      reopenClosedOrder(
        { ...order, administrativeState: 'SUSPENDED' },
        {
          authorized: true,
          actorId: 'manager',
          reason: 'x',
          scope: [{ productId: 'item-a', quantity: 1 }],
        },
      ),
    'orderSuspendedUseResume',
  );
  rejectsWithCode(
    () =>
      reopenClosedOrder(order, {
        authorized: false,
        actorId: 'manager',
        actorId: 'manager',
        reason: 'x',
        scope: [{ productId: 'item-a', quantity: 1 }],
      }),
    'forbidden',
  );
  rejectsWithCode(
    () =>
      reopenClosedOrder(order, {
        authorized: true,
        reason: 'x',
        scope: [{ productId: 'item-a', quantity: 3 }],
      }),
    'actorRequired',
  );
  rejectsWithCode(
    () =>
      reopenClosedOrder(order, {
        authorized: true,
        actorId: 'manager',
        actorId: 'manager',
        reason: 'x',
        scope: [{ productId: 'item-a', quantity: 3 }],
      }),
    'reopenScopeQuantityInvalid',
  );
  rejectsWithCode(
    () =>
      reopenClosedOrder(order, {
        authorized: true,
        actorId: 'manager',
        reason: ' ',
        scope: [{ productId: 'item-a', quantity: 1 }],
      }),
    'reasonRequired',
  );
  rejectsWithCode(
    () =>
      reopenClosedOrder(order, {
        authorized: true,
        actorId: 'manager',
        reason: 'x',
        scope: [],
      }),
    'reopenScopeRequired',
  );
  rejectsWithCode(
    () =>
      reopenClosedOrder(order, {
        authorized: true,
        actorId: 'manager',
        reason: 'x',
        scope: [{ productId: 'item-a', quantity: 6 }],
      }),
    'reopenScopeQuantityInvalid',
  );
  rejectsWithCode(
    () =>
      reopenClosedOrder(order, {
        authorized: true,
        actorId: 'manager',
        reason: 'x',
        scope: [{ productId: 'unknown', quantity: 1 }],
      }),
    'reopenScopeUnknownProduct',
  );
  rejectsWithCode(
    () =>
      reopenClosedOrder(order, {
        authorized: true,
        actorId: 'manager',
        reason: 'x',
        scope: [
          { productId: 'item-a', quantity: 1 },
          { productId: 'item-a', quantity: 1 },
        ],
      }),
    'reopenScopeDuplicateProduct',
  );
});
