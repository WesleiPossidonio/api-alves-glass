const PUBLIC_STATUSES = new Set([
  'CREATED',
  'APPROVED',
  'MATERIALS_SEPARATED',
  'IN_PRODUCTION',
  'IN_ROUTE',
  'DELIVERED',
  'CANCELLED',
]);

const ADMINISTRATIVE_STATES = new Set([
  'ACTIVE',
  'SUSPENDED',
  'CLOSED',
  'CANCELLED',
]);

export const SERVICE_ORDER_FUNCTIONAL_STATUS = Object.freeze({
  REGISTERED: 'REGISTERED',
  AWAITING_SUPPLIER: 'AWAITING_SUPPLIER',
  IN_PRODUCTION: 'IN_PRODUCTION',
  AWAITING_DELIVERY: 'AWAITING_DELIVERY',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
});

const FUNCTIONAL_TRANSITIONS = Object.freeze({
  REGISTERED: new Set(['AWAITING_SUPPLIER', 'IN_PRODUCTION']),
  AWAITING_SUPPLIER: new Set(['IN_PRODUCTION']),
  IN_PRODUCTION: new Set(),
  AWAITING_DELIVERY: new Set(['COMPLETED']),
  COMPLETED: new Set(),
  CANCELLED: new Set(),
});

export function transitionFunctionalServiceOrder(current, next) {
  if (!Object.hasOwn(FUNCTIONAL_TRANSITIONS, current))
    invalid('functionalStatusInvalid');
  if (current === 'CANCELLED') invalid('orderAlreadyCancelled');
  if (!FUNCTIONAL_TRANSITIONS[current].has(next))
    invalid('functionalStatusTransitionInvalid');
  if (next === 'COMPLETED' || next === 'AWAITING_DELIVERY')
    invalid('productionQualityPrerequisiteRequired');
  return next;
}

export class ServiceOrderDomainError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ServiceOrderDomainError';
    this.code = code;
  }
}

const invalid = (code) => {
  throw new ServiceOrderDomainError(code);
};

const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

export function createServiceOrderQueueComparator() {
  return (left, right) => {
    const leftTime = Date.parse(left?.queuedAt);
    const rightTime = Date.parse(right?.queuedAt);
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime))
      invalid('queueTimestampInvalid');
    if (leftTime !== rightTime) return leftTime - rightTime;

    return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
  };
}

export function orderServiceOrdersByQueue(orders, sectorId) {
  if (!Array.isArray(orders) || typeof sectorId !== 'string' || !sectorId)
    invalid('queueInputInvalid');
  const scoped = orders.filter((order) => order?.sectorId === sectorId);
  for (const order of scoped) {
    const timestamp = Date.parse(order?.queuedAt);
    if (!Number.isFinite(timestamp)) invalid('queueTimestampInvalid');
    if (order.id !== undefined && typeof order.id !== 'string')
      invalid('queueIdInvalid');
  }
  return scoped.slice().sort(createServiceOrderQueueComparator());
}

export function validateServiceOrderRegistration(input) {
  if (!input || typeof input !== 'object') invalid('validation');
  if (typeof input.clientId !== 'string' || !input.clientId.trim())
    invalid('clientRequired');
  if (typeof input.sectorId !== 'string' || !input.sectorId.trim())
    invalid('sectorRequired');
  const externalNumber = input.externalNumber ?? input.orderNumber;
  if (
    typeof externalNumber !== 'string' ||
    !externalNumber.trim() ||
    externalNumber.length > 64
  )
    invalid('externalNumberRequired');
  if (
    input.externalNumber !== undefined &&
    input.orderNumber !== undefined &&
    input.externalNumber !== input.orderNumber
  )
    invalid('externalNumberConflict');
  if (
    typeof input.dueAt !== 'string' ||
    !input.dueAt.trim() ||
    Number.isNaN(Date.parse(input.dueAt))
  )
    invalid('dueAtRequired');
  if (
    input.notes !== undefined &&
    (typeof input.notes !== 'string' || input.notes.length > 4000)
  )
    invalid('notesInvalid');
  if (!Array.isArray(input.products) || input.products.length === 0)
    invalid('productsRequired');

  for (const product of input.products) {
    if (!product || typeof product !== 'object') invalid('productInvalid');
    if (
      typeof product.name !== 'string' ||
      !product.name.trim() ||
      product.name.length > 240
    )
      invalid('productNameRequired');
    if (
      product.description !== undefined &&
      (typeof product.description !== 'string' ||
        product.description.length > 2000)
    )
      invalid('productDescriptionInvalid');
    if (!isPositiveInteger(product.quantity))
      invalid('quantityMustBePositiveInteger');
    if (product.unit !== undefined && product.unit !== 'UN')
      invalid('unitMustBeUN');
    if (
      product.measurements === undefined ||
      product.measurements === null ||
      typeof product.measurements !== 'object' ||
      Array.isArray(product.measurements)
    )
      invalid('measurementsInvalid');
    if (Object.keys(product.measurements).length === 0)
      invalid('measurementsRequired');
    const hasDimension = (...keys) =>
      keys.some((key) => {
        const value = product.measurements[key];
        return value !== undefined && value !== null && String(value).trim();
      });
    if (
      !hasDimension('width', 'widthMm') ||
      !hasDimension('height', 'heightMm')
    )
      invalid('widthAndHeightRequired');
    validateProductMeasurements(product.measurements);
  }

  return true;
}

export function validateProductMeasurements(measurements) {
  if (
    !measurements ||
    typeof measurements !== 'object' ||
    Array.isArray(measurements)
  )
    invalid('measurementsInvalid');
  for (const aliases of [
    ['width', 'widthMm'],
    ['height', 'heightMm'],
    ['thickness', 'thicknessMm'],
  ]) {
    if (
      aliases[0] !== 'thickness' &&
      !aliases.some(
        (key) =>
          measurements[key] !== undefined &&
          measurements[key] !== null &&
          String(measurements[key]).trim(),
      )
    )
      invalid('widthAndHeightRequired');
    for (const key of aliases) {
      if (!Object.hasOwn(measurements, key)) continue;
      const value = measurements[key];
      if (
        !['string', 'number'].includes(typeof value) ||
        (typeof value === 'string' &&
          !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
            value.trim(),
          )) ||
        !Number.isFinite(Number(value)) ||
        Number(value) <= 0
      )
        invalid('dimensionMustBeValidNumber');
    }
  }
  for (const key of ['glassColor', 'aluminumColor', 'ironColor']) {
    if (!Object.hasOwn(measurements, key)) continue;
    if (typeof measurements[key] !== 'string' || !measurements[key].trim())
      invalid('productColorInvalid');
  }
  return true;
}

export function isDuplicateServiceOrderNumberError(error) {
  return (
    error?.name === 'SequelizeUniqueConstraintError' &&
    (error?.original?.constraint ===
      'service_orders_sector_external_number_ckey' ||
      error?.parent?.constraint ===
        'service_orders_sector_external_number_ckey')
  );
}

export function determineProductTriage(quantity) {
  if (!isPositiveInteger(quantity)) invalid('quantityMustBePositiveInteger');
  return quantity >= 7 ? 'ADMIN_TRIAGE_REQUIRED' : 'NORMAL_FLOW';
}

export function transitionPublicServiceOrderStatus(currentStatus, nextStatus) {
  if (!PUBLIC_STATUSES.has(currentStatus) || !PUBLIC_STATUSES.has(nextStatus))
    invalid('publicStatusInvalid');
  if (currentStatus === 'CANCELLED') invalid('orderAlreadyCancelled');
  const transitions = {
    CREATED: new Set(['APPROVED']),
    APPROVED: new Set(['MATERIALS_SEPARATED']),
    MATERIALS_SEPARATED: new Set(['IN_PRODUCTION']),
    IN_PRODUCTION: new Set(),
    IN_ROUTE: new Set(['DELIVERED']),
    DELIVERED: new Set(),
  };
  if (!transitions[currentStatus]?.has(nextStatus))
    invalid('publicStatusTransitionInvalid');
  return nextStatus;
}

export function assertDistributionWithinQuantity(
  availableQuantity,
  allocations,
) {
  if (
    !isPositiveInteger(availableQuantity) ||
    !Array.isArray(allocations) ||
    allocations.length === 0
  )
    invalid('distributionInvalid');
  if (
    allocations.some(
      (allocation) => !allocation || !isPositiveInteger(allocation.quantity),
    )
  )
    invalid('allocationQuantityInvalid');
  const assigned = allocations.reduce(
    (sum, allocation) => sum + allocation.quantity,
    0,
  );
  if (!Number.isSafeInteger(assigned) || assigned > availableQuantity)
    invalid('allocationExceedsAvailableQuantity');
  return {
    assignedQuantity: assigned,
    remainingQuantity: availableQuantity - assigned,
  };
}

export function assertExecutionWithinAssignment(
  assignedQuantity,
  alreadyExecutedQuantity,
  executionQuantity,
) {
  if (
    ![assignedQuantity, alreadyExecutedQuantity, executionQuantity].every(
      Number.isSafeInteger,
    ) ||
    assignedQuantity < 0 ||
    alreadyExecutedQuantity < 0 ||
    !isPositiveInteger(executionQuantity)
  )
    invalid('executionQuantityInvalid');
  if (alreadyExecutedQuantity + executionQuantity > assignedQuantity)
    invalid('executionExceedsAssignment');
  return alreadyExecutedQuantity + executionQuantity;
}

export function transferWorkAssignment({
  assignment,
  assignedUserId,
  quantity,
  actorId,
  sectorId,
}) {
  if (!assignment || assignment.status !== 'ACTIVE')
    invalid('assignmentNotActive');
  if (!isPositiveInteger(quantity) || quantity > assignment.remainingQuantity)
    invalid('allocationExceedsAvailableQuantity');
  if (
    typeof assignedUserId !== 'string' ||
    !assignedUserId.trim() ||
    typeof actorId !== 'string' ||
    !actorId.trim() ||
    !sectorId ||
    assignment.sectorId !== sectorId
  )
    invalid('assignmentContextInvalid');
  return {
    previousAssignment: { ...assignment, status: 'REASSIGNED' },
    nextAssignment: {
      productId: assignment.productId,
      sectorId,
      assignedUserId,
      quantity,
      assignedBy: actorId,
      status: 'ACTIVE',
    },
  };
}

export function assertAssignedExecution({
  assignment,
  actorId,
  sectorId,
  quantity,
}) {
  if (!assignment || assignment.status !== 'ACTIVE')
    invalid('assignmentNotActive');
  if (assignment.assignedUserId !== actorId) invalid('assignmentActorMismatch');
  if (assignment.sectorId !== sectorId) invalid('assignmentSectorMismatch');
  return assertExecutionWithinAssignment(
    assignment.quantity,
    assignment.executedQuantity ?? 0,
    quantity,
  );
}

export function recordQualityInspection({
  reworkId,
  executorIds,
  executorId,
  inspectorId,
  quantity,
  remainingQuantity,
  outcome,
}) {
  if (!reworkId) invalid('reworkRequired');
  const executors = Array.isArray(executorIds) ? executorIds : [executorId];
  if (
    executors.some((id) => typeof id !== 'string' || !id.trim()) ||
    typeof inspectorId !== 'string' ||
    !inspectorId.trim()
  )
    invalid('inspectionActorsRequired');
  if (executors.length > 0 && executors.includes(inspectorId))
    invalid('selfInspectionForbidden');
  if (!isPositiveInteger(quantity) || quantity > remainingQuantity)
    invalid('inspectionQuantityInvalid');
  if (!['APPROVED', 'REJECTED'].includes(outcome))
    invalid('inspectionOutcomeInvalid');
  return { reworkId, inspectorId, quantity, outcome };
}

export function decideSpecificationRevision({
  currentRevision,
  requestedRevision,
  decision,
  actorId,
}) {
  if (
    !isPositiveInteger(currentRevision) ||
    currentRevision >= Number.MAX_SAFE_INTEGER ||
    !requestedRevision ||
    typeof requestedRevision !== 'object' ||
    Array.isArray(requestedRevision) ||
    Object.keys(requestedRevision).length === 0
  )
    invalid('revisionInvalid');
  if (decision === 'APPROVED' && currentRevision + 1 >= Number.MAX_SAFE_INTEGER)
    invalid('revisionInvalid');
  if (
    !requestedRevision.measurements ||
    typeof requestedRevision.measurements !== 'object' ||
    Array.isArray(requestedRevision.measurements) ||
    Object.keys(requestedRevision.measurements).length === 0
  )
    invalid('measurementsInvalid');
  if (!['APPROVED', 'REJECTED'].includes(decision))
    invalid('revisionDecisionInvalid');
  if (typeof actorId !== 'string' || !actorId.trim()) invalid('actorRequired');
  if (decision === 'REJECTED')
    return {
      currentRevision,
      requestedRevision: { ...requestedRevision },
      status: 'REJECTED',
      decidedBy: actorId,
    };
  if (
    typeof requestedRevision.reason !== 'string' ||
    !requestedRevision.reason.trim()
  )
    invalid('reasonRequired');
  const nextRevision = currentRevision + 1;
  return {
    currentRevision: nextRevision,
    revision: {
      ...requestedRevision,
      measurements: { ...requestedRevision.measurements },
      number: nextRevision,
    },
    status: 'APPROVED',
    decidedBy: actorId,
    previousRevision: currentRevision,
    reason: requestedRevision.reason.trim(),
  };
}

export function requestSpecificationRevision({
  currentRevision,
  requestedMeasurements,
  reason,
  actorId,
}) {
  if (!isPositiveInteger(currentRevision)) invalid('revisionInvalid');
  if (currentRevision >= Number.MAX_SAFE_INTEGER) invalid('revisionInvalid');
  if (
    !requestedMeasurements ||
    typeof requestedMeasurements !== 'object' ||
    Array.isArray(requestedMeasurements) ||
    Object.keys(requestedMeasurements).length === 0
  )
    invalid('measurementsInvalid');
  if (typeof reason !== 'string' || !reason.trim()) invalid('reasonRequired');
  if (typeof actorId !== 'string' || !actorId.trim()) invalid('actorRequired');
  return {
    revision: currentRevision + 1,
    status: 'PENDING',
    requestedBy: actorId,
    reason: reason.trim(),
    requestedMeasurements: { ...requestedMeasurements },
  };
}

export function reportProductNonconformity({
  productId,
  reporterId,
  quantity,
  availableQuantity,
  issue,
}) {
  if (!productId || !reporterId) invalid('qualityContextRequired');
  if (!isPositiveInteger(quantity) || quantity > availableQuantity)
    invalid('qualityQuantityInvalid');
  if (typeof issue !== 'string' || !issue.trim())
    invalid('qualityIssueRequired');
  return {
    productId,
    reportedBy: reporterId,
    quantity,
    issue: issue.trim(),
    status: 'OPEN',
  };
}

export function recordQualityDisposition({
  qualityAction,
  disposition,
  actorId,
  reworkExecutorId,
}) {
  if (!qualityAction || !['OPEN', 'REWORK'].includes(qualityAction.status))
    invalid('qualityActionNotOpen');
  if (!['REWORK', 'REJECT', 'APPROVE'].includes(disposition))
    invalid('qualityDispositionInvalid');
  if (typeof actorId !== 'string' || !actorId.trim()) invalid('actorRequired');
  if (
    disposition === 'REWORK' &&
    (typeof reworkExecutorId !== 'string' || !reworkExecutorId.trim())
  )
    invalid('reworkExecutorRequired');
  return {
    ...qualityAction,
    disposition,
    status:
      disposition === 'REWORK'
        ? 'REWORK'
        : disposition === 'APPROVE'
          ? 'APPROVED'
          : 'REJECTED',
    decidedBy: actorId,
    ...(disposition === 'REWORK' ? { reworkExecutorId } : {}),
  };
}

export function deriveProductProductionState({
  quantity,
  completedQuantity = 0,
  blockedQuantity = 0,
  hasStarted = false,
  hasPendingQuality = false,
}) {
  if (!isPositiveInteger(quantity)) invalid('quantityMustBePositiveInteger');
  if (
    !Number.isSafeInteger(completedQuantity) ||
    !Number.isSafeInteger(blockedQuantity) ||
    completedQuantity < 0 ||
    blockedQuantity < 0 ||
    completedQuantity + blockedQuantity > quantity
  )
    invalid('productProgressInvalid');
  if (blockedQuantity > 0 || hasPendingQuality) return 'QUALITY_BLOCKED';
  if (completedQuantity === quantity) return 'PRODUCTION_COMPLETED';
  if (hasStarted || completedQuantity > 0) return 'IN_PRODUCTION';
  return 'QUEUED';
}

export function canCompleteProduction(products) {
  if (!Array.isArray(products) || products.length === 0)
    invalid('productsRequired');
  for (const product of products) {
    if (
      !product ||
      !isPositiveInteger(product.quantity) ||
      !Number.isSafeInteger(product.completedQuantity) ||
      !Number.isSafeInteger(product.blockedQuantity) ||
      !Number.isSafeInteger(product.pendingQuality) ||
      product.completedQuantity < 0 ||
      product.blockedQuantity < 0 ||
      product.pendingQuality < 0 ||
      product.completedQuantity + product.blockedQuantity > product.quantity
    )
      invalid('productProgressInvalid');
  }
  return products.every(
    (product) =>
      product.completedQuantity === product.quantity &&
      product.blockedQuantity === 0 &&
      product.pendingQuality === 0,
  );
}

export function derivePublicProductionStatus({
  currentPublicStatus,
  productStatuses,
  administrativeState,
}) {
  if (!PUBLIC_STATUSES.has(currentPublicStatus)) invalid('publicStatusInvalid');
  if (!ADMINISTRATIVE_STATES.has(administrativeState))
    invalid('administrativeStateInvalid');
  if (!Array.isArray(productStatuses)) invalid('productStatusesInvalid');
  if (administrativeState === 'CANCELLED') return 'CANCELLED';
  if (administrativeState === 'SUSPENDED' || administrativeState === 'CLOSED')
    return currentPublicStatus;
  if (productStatuses.length === 0) return currentPublicStatus;
  if (
    productStatuses.length > 0 &&
    productStatuses.every((status) => status === 'PRODUCTION_COMPLETED')
  )
    return currentPublicStatus;
  return productStatuses.includes('IN_PRODUCTION')
    ? 'IN_PRODUCTION'
    : currentPublicStatus;
}

export function resumeSuspendedOrder(
  administrativeState,
  { authorized, blockers = [] } = {},
) {
  if (administrativeState !== 'SUSPENDED') invalid('orderNotSuspended');
  if (authorized !== true) invalid('forbidden');
  if (!Array.isArray(blockers)) invalid('blockersInvalid');
  if (blockers.length > 0) invalid('resumeBlocked');
  return { administrativeState: 'ACTIVE', createsCycle: false };
}

export function cancelServiceOrder(
  administrativeState,
  { authorized, reason } = {},
) {
  if (!ADMINISTRATIVE_STATES.has(administrativeState))
    invalid('administrativeStateInvalid');
  if (administrativeState === 'CANCELLED') invalid('orderAlreadyCancelled');
  if (authorized !== true) invalid('forbidden');
  if (reason !== undefined && reason !== null && typeof reason !== 'string')
    invalid('reasonInvalid');
  return { administrativeState: 'CANCELLED', terminal: true };
}

export function suspendServiceOrder(
  administrativeState,
  { authorized, reason } = {},
) {
  if (administrativeState !== 'ACTIVE') invalid('orderNotActive');
  if (authorized !== true) invalid('forbidden');
  if (typeof reason !== 'string' || !reason.trim()) invalid('reasonRequired');
  return {
    administrativeState: 'SUSPENDED',
    reason: reason.trim(),
    terminal: false,
  };
}

export function closeServiceOrder(
  administrativeState,
  { authorized, completed } = {},
) {
  if (administrativeState !== 'ACTIVE') invalid('orderNotActive');
  if (authorized !== true) invalid('forbidden');
  if (completed !== true) invalid('productionNotComplete');
  return { administrativeState: 'CLOSED', closed: true };
}

export function reopenClosedOrder(
  order,
  { authorized, reason, scope, actorId } = {},
) {
  if (!order || !ADMINISTRATIVE_STATES.has(order.administrativeState))
    invalid('administrativeStateInvalid');
  if (order.administrativeState === 'CANCELLED') invalid('orderCancelled');
  if (order.administrativeState === 'SUSPENDED')
    invalid('orderSuspendedUseResume');
  if (order.administrativeState !== 'CLOSED') invalid('orderNotClosed');
  if (authorized !== true) invalid('forbidden');
  if (typeof actorId !== 'string' || !actorId.trim()) invalid('actorRequired');
  if (typeof reason !== 'string' || !reason.trim()) invalid('reasonRequired');
  if (!Array.isArray(scope) || scope.length === 0)
    invalid('reopenScopeRequired');

  if (!Array.isArray(order.products) || order.products.length === 0)
    invalid('reopenProductsRequired');
  if (!Array.isArray(order.cycles)) invalid('reopenCyclesInvalid');
  const productQuantities = new Map(
    order.products.map((product) => {
      if (
        !product ||
        typeof product.id !== 'string' ||
        !isPositiveInteger(product.quantity)
      )
        invalid('reopenProductsInvalid');
      return [product.id, product.quantity];
    }),
  );
  const seen = new Set();
  const normalizedScope = scope.map((entry) => {
    if (
      !entry ||
      typeof entry.productId !== 'string' ||
      !entry.productId.trim()
    )
      invalid('reopenScopeInvalid');
    if (seen.has(entry.productId)) invalid('reopenScopeDuplicateProduct');
    seen.add(entry.productId);
    const quantity = productQuantities.get(entry.productId);
    if (!isPositiveInteger(quantity)) invalid('reopenScopeUnknownProduct');
    const completed = entry.productId
      ? (order.products.find((product) => product.id === entry.productId)
          ?.approvedQuantity ?? 0)
      : 0;
    const outstandingQuantity = quantity - completed;
    if (
      !isPositiveInteger(entry.quantity) ||
      entry.quantity > outstandingQuantity
    )
      invalid('reopenScopeQuantityInvalid');
    return { productId: entry.productId, quantity: entry.quantity };
  });

  const nextCycle =
    (order.cycles || []).reduce(
      (highest, cycle) => Math.max(highest, cycle.number || 0),
      0,
    ) + 1;
  return {
    administrativeState: 'ACTIVE',
    createsCycle: true,
    cycle: {
      number: nextCycle,
      reason: reason.trim(),
      reopenedBy: actorId,
      scope: normalizedScope,
    },
    priorCycles: order.cycles || [],
  };
}
