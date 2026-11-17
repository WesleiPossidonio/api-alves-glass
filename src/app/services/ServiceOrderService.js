import {
  assertDistributionWithinQuantity,
  assertExecutionWithinAssignment,
  cancelServiceOrder,
  closeServiceOrder,
  determineProductTriage,
  reopenClosedOrder,
  resumeSuspendedOrder,
  suspendServiceOrder,
  validateServiceOrderRegistration,
  validateProductMeasurements,
  reportProductNonconformity,
  recordQualityDisposition,
  recordQualityInspection,
  transitionPublicServiceOrderStatus,
  isDuplicateServiceOrderNumberError,
  transitionFunctionalServiceOrder,
} from './serviceOrderDomain.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import ServiceOrderAssignmentRepository from '../repositories/ServiceOrderAssignmentRepository.js';
import ServiceOrderRepository from '../repositories/ServiceOrderRepository.js';
import ServiceOrderEventRepository from '../repositories/ServiceOrderEventRepository.js';
import ServiceOrderQualityRepository from '../repositories/ServiceOrderQualityRepository.js';
import ServiceOrderPermissionRepository from '../repositories/ServiceOrderPermissionRepository.js';
import { SECTOR_MANAGER_OPERATIONS } from '../repositories/ServiceOrderPermissionRepository.js';
import ServiceOrderOperationGrant from '../models/ServiceOrderOperationGrant.js';
import { Op } from 'sequelize';
import { isDeepStrictEqual } from 'node:util';
import ServiceOrderReadService from './ServiceOrderReadService.js';
import Database from '../../database/index.js';

export class ServiceOrderApplicationError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'ServiceOrderApplicationError';
    this.code = code;
    this.status = status;
  }
}

export class ServiceOrderService {
  constructor({
    database,
    orders,
    events,
    permissions,
    assignments,
    quality,
    readService,
  }) {
    this.database = database;
    this.orders = orders;
    this.events = events;
    this.permissions = permissions;
    this.assignments = assignments;
    this.quality = quality;
    this.readService = readService ?? new ServiceOrderReadService();
  }

  async register(input, actor) {
    validateServiceOrderRegistration(input);
    this.assertUser(actor);
    try {
      return await this.database.connection.transaction(async (transaction) => {
        await this.assertSectorOperation(
          actor.id,
          input.sectorId,
          'CREATE',
          transaction,
        );
        await this.requireCurrentSectorGrant(actor.id, input.sectorId, {
          transaction,
          lock: true,
        });
        const order = await this.orders.create(
          {
            ...input,
            externalNumber: input.externalNumber ?? input.orderNumber,
            createdBy: actor.id,
          },
          { transaction, products: input.products },
        );
        const registered = await this.events.append(
          {
            aggregateId: order.id,
            sectorId: order.sector_id,
            actorUserId: actor.id,
            eventType: 'ServiceOrderRegistered',
            payload: {
              clientId: order.client_id,
              externalNumber: order.external_number,
              notes: input.notes ?? null,
              dueAt: order.due_at,
            },
          },
          { transaction },
        );
        const firstProductVersion = BigInt(registered.aggregate_version) + 1n;
        const createdProducts =
          order.products ??
          (await this.orders.getProducts(order.id, { transaction }));
        for (const [index, product] of createdProducts.entries()) {
          await this.events.append(
            {
              aggregateId: order.id,
              sectorId: order.sector_id,
              productItemId: product.id,
              actorUserId: actor.id,
              eventType: 'ServiceOrderProductRegistered',
              payload: {
                productId: product.id,
                name: product.name,
                quantity: product.quantity,
                unit: 'UN',
                measurements: product.measurements,
              },
            },
            {
              transaction,
              expectedVersion: (firstProductVersion + BigInt(index)).toString(),
            },
          );
        }
        return order;
      });
    } catch (error) {
      if (isDuplicateServiceOrderNumberError(error))
        throw new ServiceOrderApplicationError(
          'duplicateServiceOrderNumber',
          409,
        );
      throw error;
    }
  }

  async assumeByExternalNumber({ sectorId, externalNumber }, actor) {
    this.assertUser(actor);
    if (
      !sectorId ||
      typeof externalNumber !== 'string' ||
      !externalNumber.trim()
    )
      throw new ServiceOrderApplicationError(
        'sectorAndExternalNumberRequired',
        422,
      );
    return this.database.connection.transaction(async (transaction) => {
      if (
        !(await this.orders.lockUserSectorMembership(actor.id, sectorId, {
          transaction,
        }))
      )
        throw new ServiceOrderApplicationError('sectorGrantRequired', 403);
      const order = await this.orders.findBySectorAndExternalNumber(
        sectorId,
        externalNumber,
        { transaction, lock: true },
      );
      if (!order)
        throw new ServiceOrderApplicationError('serviceOrderNotFound', 404);
      if (
        ![
          'REGISTERED',
          'AWAITING_SUPPLIER',
          'IN_PRODUCTION',
          'AWAITING_DELIVERY',
        ].includes(order.functional_status)
      )
        throw new ServiceOrderApplicationError('orderNotAssumable', 409);
      await this.orders.lockUserResponsibility(actor.id, { transaction });
      if (
        await this.orders.findActiveResponsibility(order.id, {
          transaction,
          lock: true,
        })
      )
        throw new ServiceOrderApplicationError('orderAlreadyAssigned', 409);
      if (
        await this.orders.findActiveResponsibilityForUser(actor.id, {
          transaction,
          lock: true,
        })
      )
        throw new ServiceOrderApplicationError(
          'userAlreadyHasActiveOrder',
          409,
        );
      const responsibility = await this.orders.assignResponsibility(
        { orderId: order.id, userId: actor.id, actorId: actor.id },
        { transaction },
      );
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId,
          actorUserId: actor.id,
          eventType: 'ServiceOrderAssumed',
          payload: { userId: actor.id, responsibilityId: responsibility.id },
        },
        { transaction },
      );
      return responsibility;
    });
  }

  async releaseResponsibility(
    orderId,
    { nextUserId, reason = null } = {},
    actor,
  ) {
    this.assertUser(actor);
    return this.database.connection.transaction(async (transaction) => {
      const order = await this.orders.findById(orderId, {
        transaction,
        lock: true,
      });
      if (!order)
        throw new ServiceOrderApplicationError('serviceOrderNotFound', 404);
      if (actor.role !== 'admin') {
        await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
          transaction,
          lock: true,
        });
        await this.assertManagerPermission(
          actor.id,
          order.sector_id,
          'MANAGE_RESPONSIBILITY',
          transaction,
        );
      }
      if (
        ![
          'REGISTERED',
          'AWAITING_SUPPLIER',
          'IN_PRODUCTION',
          'AWAITING_DELIVERY',
        ].includes(order.functional_status)
      )
        throw new ServiceOrderApplicationError('orderNotAssignable', 409);
      const active = await this.orders.findActiveResponsibility(order.id, {
        transaction,
        lock: true,
      });
      if (!active)
        throw new ServiceOrderApplicationError(
          'activeResponsibilityNotFound',
          409,
        );
      await this.orders.lockUserResponsibility(active.user_id, { transaction });
      if (nextUserId) {
        if (
          !(await this.orders.lockUserSectorMembership(
            nextUserId,
            order.sector_id,
            { transaction },
          ))
        )
          throw new ServiceOrderApplicationError(
            'targetSectorGrantRequired',
            409,
          );
        await this.orders.lockUserResponsibility(nextUserId, { transaction });
      }
      await this.orders.releaseResponsibility(
        active,
        { actorId: actor.id, reason },
        { transaction },
      );
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          actorUserId: actor.id,
          eventType: 'ServiceOrderResponsibilityReleased',
          payload: {
            userId: active.user_id,
            nextUserId: nextUserId ?? null,
            reason,
          },
        },
        { transaction },
      );
      if (!nextUserId) return { released: true };
      if (
        await this.orders.findActiveResponsibilityForUser(nextUserId, {
          transaction,
          lock: true,
        })
      )
        throw new ServiceOrderApplicationError(
          'userAlreadyHasActiveOrder',
          409,
        );
      const responsibility = await this.orders.assignResponsibility(
        { orderId: order.id, userId: nextUserId, actorId: actor.id },
        { transaction },
      );
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          actorUserId: actor.id,
          eventType: 'ServiceOrderAssumed',
          payload: {
            userId: nextUserId,
            responsibilityId: responsibility.id,
            transferred: true,
          },
        },
        { transaction },
      );
      return responsibility;
    });
  }

  async transitionFunctionalStatus(orderId, nextStatus, actor) {
    this.assertUser(actor);
    return this.database.connection.transaction(async (transaction) => {
      const order = await this.orders.findById(orderId, {
        transaction,
        lock: true,
      });
      if (!order)
        throw new ServiceOrderApplicationError('serviceOrderNotFound', 404);
      if (actor.role !== 'admin') {
        await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
          transaction,
          lock: true,
        });
        await this.assertSectorOperation(
          actor.id,
          order.sector_id,
          'ADVANCE_STATUS',
          transaction,
        );
      }
      if (!['AWAITING_SUPPLIER', 'IN_PRODUCTION'].includes(nextStatus))
        throw new ServiceOrderApplicationError(
          'functionalStatusTransitionInvalid',
          409,
        );
      let status;
      try {
        status = transitionFunctionalServiceOrder(
          order.functional_status,
          nextStatus,
        );
      } catch (error) {
        throw new ServiceOrderApplicationError(error.code, 409);
      }
      const previousStatus = order.functional_status;
      await order.update({ functional_status: status }, { transaction });
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          actorUserId: actor.id,
          eventType: 'ServiceOrderFunctionalStatusChanged',
          payload: { previousStatus, status },
        },
        { transaction },
      );
      return { functionalStatus: status };
    });
  }

  async assign({ orderId, productId, assigneeId, quantity }, actor) {
    this.assertUser(actor);
    return this.database.connection.transaction(async (transaction) => {
      const order = await this.orders.findById(orderId, {
        transaction,
        lock: true,
      });
      this.assertOrder(order);
      if (order.administrative_state !== 'ACTIVE')
        throw new ServiceOrderApplicationError('orderNotActive', 409);
      await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
        transaction,
        lock: true,
      });
      await this.permissions.assertPermission(
        actor.id,
        order.sector_id,
        'ASSIGN',
        {
          transaction,
          lock: true,
        },
      );
      const product = order.products.find(({ id }) => id === productId);
      if (!product)
        throw new ServiceOrderApplicationError('productNotFound', 404);
      if (order.production_completed)
        throw new ServiceOrderApplicationError(
          'productionAlreadyCompleted',
          409,
        );
      const triageEvent = await this.events.findLatestEvent(
        order.id,
        'ServiceOrderTriaged',
        { transaction },
      );
      const triage = triageEvent?.payload?.products?.find(
        (entry) => entry.productId === productId,
      );
      if (
        Number(product.quantity) >= 7 &&
        triage?.outcome !== 'ADMIN_TRIAGE_REQUIRED'
      )
        throw new ServiceOrderApplicationError('triageRequired', 409);
      const assigned = await this.assignments.sumActiveForProduct(productId, {
        transaction,
      });
      const allocation = assertDistributionWithinQuantity(
        Number(product.quantity) -
          product.completed_quantity -
          product.blocked_quantity -
          assigned,
        [{ quantity }],
      );
      if (
        !(await this.orders.lockSectorGrant(assigneeId, order.sector_id, {
          transaction,
        }))
      )
        throw new ServiceOrderApplicationError(
          'assigneeSectorGrantRequired',
          403,
        );
      await this.permissions.assertPermission(
        assigneeId,
        order.sector_id,
        'RECORD_EXECUTION',
        {
          transaction,
          lock: true,
        },
      );
      const assignment = await this.assignments.create(
        {
          orderId,
          productId,
          sectorId: order.sector_id,
          assignedUserId: assigneeId,
          assignedBy: actor.id,
          quantity: allocation.assignedQuantity,
        },
        { transaction },
      );
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          productItemId: product.id,
          actorUserId: actor.id,
          eventType: 'WorkAssigned',
          payload: { assignmentId: assignment.id, assigneeId, quantity },
        },
        { transaction },
      );
      return assignment;
    });
  }

  async recordExecution({ assignmentId, quantity }, actor) {
    this.assertUser(actor);
    return this.database.connection.transaction(async (transaction) => {
      const assignment = await this.assignments.findById(assignmentId, {
        transaction,
        lock: true,
      });
      if (!assignment)
        throw new ServiceOrderApplicationError('assignmentNotFound', 404);
      if (assignment.status !== 'ACTIVE')
        throw new ServiceOrderApplicationError('assignmentNotActive', 409);
      if (assignment.assigned_user_id !== actor.id)
        throw new ServiceOrderApplicationError('assignmentActorMismatch', 403);
      const order = await this.orders.findById(assignment.service_order_id, {
        transaction,
        lock: true,
      });
      this.assertOrder(order);
      if (order.administrative_state !== 'ACTIVE')
        throw new ServiceOrderApplicationError('orderNotActive', 409);
      await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
        transaction,
        lock: true,
      });
      await this.permissions.assertPermission(
        actor.id,
        order.sector_id,
        'RECORD_EXECUTION',
        { transaction, lock: true },
      );
      if (order.production_completed)
        throw new ServiceOrderApplicationError(
          'productionAlreadyCompleted',
          409,
        );
      const nextExecuted = assertExecutionWithinAssignment(
        assignment.quantity,
        Number(assignment.executed_quantity),
        quantity,
      );
      const reworkAction = await this.quality.findActiveForProduct(
        assignment.product_id,
        { transaction },
      );
      if (
        reworkAction?.rework_executor_id &&
        reworkAction.rework_executor_id !== actor.id
      )
        throw new ServiceOrderApplicationError('reworkExecutorMismatch', 403);
      const execution = await this.assignments.recordExecution(
        assignment,
        { quantity, performedBy: actor.id },
        { transaction },
      );
      const product = order.products.find(
        ({ id }) => id === assignment.product_id,
      );
      if (
        Number(product.completed_quantity) + quantity >
        Number(product.quantity)
      )
        throw new ServiceOrderApplicationError('productQuantityExceeded', 409);
      const pendingQuality = await this.quality.findActiveForProduct(
        product.id,
        { transaction },
      );
      if (pendingQuality)
        throw new ServiceOrderApplicationError('qualityInspectionPending', 409);
      const productCompletedQuantity =
        Number(product.completed_quantity) + quantity;
      await this.orders.applyProductProgress(
        product.id,
        {
          completedQuantity: productCompletedQuantity,
          blockedQuantity: Number(product.blocked_quantity),
        },
        { transaction },
      );
      const executionRevision = Number(product.specification_revision);
      const activeCycle = (order.cycles ?? []).find((cycle) => cycle.active);
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          productItemId: assignment.product_id,
          actorUserId: actor.id,
          revision: executionRevision,
          cycle: activeCycle?.cycle_number ?? 1,
          eventType: 'WorkProgressRecorded',
          payload: {
            assignmentId,
            quantity,
            assignmentExecutedQuantity: nextExecuted,
            completedQuantity: productCompletedQuantity,
            ...(reworkAction ? { qualityId: reworkAction.id } : {}),
          },
        },
        { transaction },
      );
      return execution;
    });
  }

  async releaseAssignment(assignmentId, actor) {
    this.assertUser(actor);
    return this.database.connection.transaction(async (transaction) => {
      const assignment = await this.assignments.findById(assignmentId, {
        transaction,
        lock: true,
      });
      if (!assignment)
        throw new ServiceOrderApplicationError('assignmentNotFound', 404);
      const order = await this.orders.findById(assignment.service_order_id, {
        transaction,
        lock: true,
      });
      this.assertOrder(order);
      if (
        order.administrative_state === 'CLOSED' ||
        order.administrative_state === 'CANCELLED' ||
        order.production_completed
      )
        throw new ServiceOrderApplicationError('orderNotActive', 409);
      await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
        transaction,
        lock: true,
      });
      await this.permissions.assertPermission(
        actor.id,
        order.sector_id,
        'REASSIGN',
        { transaction, lock: true },
      );
      const released = await this.assignments.release(
        assignment,
        { actorId: actor.id },
        { transaction },
      );
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          productItemId: assignment.product_id,
          actorUserId: actor.id,
          eventType: 'WorkAssignmentReleased',
          payload: {
            assignmentId,
            releasedQuantity: released.releasedQuantity,
          },
        },
        { transaction },
      );
      return released;
    });
  }

  async reassign({ assignmentId, assigneeId, quantity }, actor) {
    this.assertUser(actor);
    return this.database.connection.transaction(async (transaction) => {
      const assignment = await this.assignments.findById(assignmentId, {
        transaction,
        lock: true,
      });
      if (!assignment)
        throw new ServiceOrderApplicationError('assignmentNotFound', 404);
      const order = await this.orders.findById(assignment.service_order_id, {
        transaction,
        lock: true,
      });
      this.assertOrder(order);
      await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
        transaction,
        lock: true,
      });
      await this.permissions.assertPermission(
        actor.id,
        order.sector_id,
        'REASSIGN',
        {
          transaction,
          lock: true,
        },
      );
      const remaining = Number(assignment.remaining_quantity);
      if (
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > remaining
      )
        throw new ServiceOrderApplicationError(
          'reassignmentQuantityInvalid',
          422,
        );
      if (
        !(await this.orders.lockSectorGrant(assigneeId, order.sector_id, {
          transaction,
        }))
      )
        throw new ServiceOrderApplicationError(
          'assigneeSectorGrantRequired',
          403,
        );
      await this.permissions.assertPermission(
        assigneeId,
        order.sector_id,
        'RECORD_EXECUTION',
        { transaction, lock: true },
      );
      const replacement = await this.assignments.reassign(
        assignment,
        { assignedUserId: assigneeId, actorId: actor.id, quantity },
        { transaction },
      );
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          productItemId: assignment.product_id,
          actorUserId: actor.id,
          eventType: 'WorkReassigned',
          payload: {
            previousAssignmentId: assignment.id,
            replacementAssignmentId: replacement.id,
            assigneeId,
            quantity,
          },
        },
        { transaction },
      );
      return replacement;
    });
  }

  async reportQuality({ orderId, productId, quantity, issue }, actor) {
    this.assertUser(actor);
    return this.database.connection.transaction(async (transaction) => {
      const order = await this.orders.findById(orderId, {
        transaction,
        lock: true,
      });
      this.assertOrder(order);
      if (order.administrative_state !== 'ACTIVE')
        throw new ServiceOrderApplicationError('orderNotActive', 409);
      if (order.production_completed)
        throw new ServiceOrderApplicationError(
          'productionAlreadyCompleted',
          409,
        );
      await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
        transaction,
        lock: true,
      });
      const responsibility = await this.orders.findActiveResponsibility(
        order.id,
        { transaction, lock: true },
      );
      if (!responsibility || responsibility.user_id !== actor.id)
        throw new ServiceOrderApplicationError('responsibilityRequired', 403);
      const product = order.products.find(({ id }) => id === productId);
      if (!product)
        throw new ServiceOrderApplicationError('productNotFound', 404);
      await this.orders.lockProduct?.(productId, { transaction });
      const orderActions = await this.quality.getForOrder(order.id, {
        transaction,
      });
      const productActions = orderActions.filter(
        (row) => row.product_id === productId,
      );
      const children = new Set(
        productActions.map((row) => row.parent_quality_id).filter(Boolean),
      );
      const rejectedLeaves = productActions.filter(
        (row) =>
          row.status === 'REJECTED' &&
          Number(row.rejected_quantity) > 0 &&
          !children.has(row.id),
      );
      const parentQuality =
        rejectedLeaves.length === 1 ? rejectedLeaves[0] : null;
      if (
        productActions.length === 0 &&
        Number(product.completed_quantity) < Number(product.quantity)
      )
        throw new ServiceOrderApplicationError(
          'productNotPhysicallyComplete',
          409,
        );
      const pending = productActions.some((row) => row.status === 'OPEN');
      if (pending)
        throw new ServiceOrderApplicationError('qualityAlreadyPending', 409);
      const firstSignal = productActions.length === 0;
      const availableQuantity = firstSignal
        ? Number(product.quantity)
        : Number(parentQuality?.rejected_quantity ?? 0);
      const rejected = !firstSignal;
      if (
        !Number.isSafeInteger(quantity) ||
        quantity !== availableQuantity ||
        quantity < 1 ||
        (!firstSignal && !parentQuality)
      )
        throw new ServiceOrderApplicationError(
          'qualitySignalQuantityInvalid',
          422,
        );
      const qualityInput = {
        productId,
        reportedBy: actor.id,
        quantity,
        issue: issue ?? 'Sinalizado para conferência de qualidade',
        parentQualityId: parentQuality?.id ?? null,
      };
      const action = await this.quality.create(
        {
          ...qualityInput,
          orderId,
        },
        { transaction },
      );
      if (parentQuality)
        await this.orders.applyProductProgress(
          productId,
          {
            completedQuantity: Number(product.completed_quantity) + quantity,
            blockedQuantity: Math.max(
              0,
              Number(product.blocked_quantity) - quantity,
            ),
          },
          { transaction },
        );
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          productItemId: productId,
          actorUserId: actor.id,
          eventType: rejected
            ? 'ProductReinspectionSignaled'
            : 'ProductQualityInspectionSignaled',
          payload: {
            qualityId: action.id,
            quantity,
            issue: qualityInput.issue,
            reinspection: Boolean(rejected),
            parentQualityId: parentQuality?.id ?? null,
            completedQuantity: parentQuality
              ? Number(product.completed_quantity) + quantity
              : Number(product.completed_quantity),
            blockedQuantity: parentQuality
              ? Math.max(0, Number(product.blocked_quantity) - quantity)
              : Number(product.blocked_quantity),
          },
        },
        { transaction },
      );
      return action;
    });
  }

  async signalProductForInspection({ orderId, productId, quantity }, actor) {
    return this.reportQuality({ orderId, productId, quantity }, actor);
  }

  async getPendingQualityInspections(sectorId, externalNumber, actor) {
    this.assertUser(actor);
    const order = await this.orders.findBySectorAndExternalNumber(
      sectorId,
      externalNumber,
    );
    if (!order)
      throw new ServiceOrderApplicationError('serviceOrderNotFound', 404);
    await this.requireCurrentSectorGrant(actor.id, sectorId);
    await this.permissions.assertPermission(
      actor.id,
      sectorId,
      'RECORD_QUALITY',
    );
    const pending = await this.quality.findPendingBySector(sectorId);
    return pending.filter((action) => action.service_order_id === order.id);
  }

  async getQualityQueue(sectorId, actor, externalNumber = undefined) {
    this.assertUser(actor);
    await this.requireCurrentSectorGrant(actor.id, sectorId);
    await this.permissions.assertPermission(
      actor.id,
      sectorId,
      'RECORD_QUALITY',
    );
    const pending = await this.quality.findPendingBySector(sectorId);
    return externalNumber === undefined
      ? pending
      : pending.filter(
          (action) => action.serviceOrder?.external_number === externalNumber,
        );
  }

  async decideQuality({ qualityId, disposition, reworkExecutorId }, actor) {
    return this.decideQualityAction(
      { qualityId, disposition, reworkExecutorId },
      actor,
    );
  }

  async decideQualityAction(
    { qualityId, disposition, reworkExecutorId },
    actor,
  ) {
    this.assertUser(actor);
    return this.database.connection.transaction(async (transaction) => {
      const action = await this.quality.findById(qualityId, {
        transaction,
        lock: true,
      });
      if (!action)
        throw new ServiceOrderApplicationError('qualityNotFound', 404);
      const order = await this.orders.findById(action.service_order_id, {
        transaction,
        lock: true,
      });
      this.assertOrder(order);
      if (order.administrative_state !== 'ACTIVE')
        throw new ServiceOrderApplicationError('orderNotActive', 409);
      await this.orders.lockProduct?.(action.product_id, { transaction });
      if (order.production_completed)
        throw new ServiceOrderApplicationError(
          'productionAlreadyCompleted',
          409,
        );
      await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
        transaction,
        lock: true,
      });
      await this.permissions.assertPermission(
        actor.id,
        order.sector_id,
        'RECORD_QUALITY',
        { transaction, lock: true },
      );
      const decision = recordQualityDisposition({
        qualityAction: action,
        disposition,
        actorId: actor.id,
        reworkExecutorId,
      });
      if (reworkExecutorId) {
        if (
          !(await this.orders.lockSectorGrant(
            reworkExecutorId,
            order.sector_id,
            { transaction },
          ))
        )
          throw new ServiceOrderApplicationError(
            'reworkExecutorSectorGrantRequired',
            403,
          );
        await this.permissions.assertPermission(
          reworkExecutorId,
          order.sector_id,
          'RECORD_EXECUTION',
          { transaction, lock: true },
        );
      }
      const updated = await this.quality.decide(
        action,
        { ...decision, reworkExecutorId },
        { transaction },
      );
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          productItemId: action.product_id,
          actorUserId: actor.id,
          eventType: 'QualityDispositionRecorded',
          payload: {
            qualityId,
            disposition,
            status: decision.status,
            ...(reworkExecutorId ? { reworkExecutorId } : {}),
          },
        },
        { transaction },
      );
      return updated;
    });
  }

  async inspectQuality({ qualityId, quantity, outcome, reason }, actor) {
    this.assertUser(actor);
    return this.database.connection.transaction(async (transaction) => {
      let action = await this.quality.findById(qualityId, {
        transaction,
      });
      if (!action)
        throw new ServiceOrderApplicationError('qualityNotFound', 404);
      const order = await this.orders.findById(action.service_order_id, {
        transaction,
        lock: true,
      });
      this.assertOrder(order);
      if (order.administrative_state !== 'ACTIVE')
        throw new ServiceOrderApplicationError('orderNotActive', 409);
      if (order.production_completed)
        throw new ServiceOrderApplicationError(
          'productionAlreadyCompleted',
          409,
        );
      action = await this.quality.findById(qualityId, {
        transaction,
        lock: true,
      });
      await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
        transaction,
        lock: true,
      });
      await this.permissions.assertPermission(
        actor.id,
        order.sector_id,
        'RECORD_QUALITY',
        { transaction, lock: true },
      );
      const product = order.products?.find(
        ({ id }) => id === action.product_id,
      );
      if (order.products?.length && !product)
        throw new ServiceOrderApplicationError('productNotFound', 404);
      const pendingAction = this.quality.findActiveForProductUpdate
        ? await this.quality.findActiveForProductUpdate(action.product_id, {
            transaction,
          })
        : action;
      if (
        pendingAction &&
        pendingAction.id !== action.id &&
        pendingAction.status === 'OPEN'
      )
        throw new ServiceOrderApplicationError('qualityNotPending', 409);
      if (action.status !== 'OPEN')
        throw new ServiceOrderApplicationError('qualityNotPending', 409);
      if (
        action.status === 'OPEN' &&
        Number(action.approved_quantity) + Number(action.rejected_quantity) >=
          Number(action.affected_quantity)
      )
        throw new ServiceOrderApplicationError('qualityNotPending', 409);
      if (
        outcome === 'REJECTED' &&
        (typeof reason !== 'string' || !reason.trim())
      )
        throw new ServiceOrderApplicationError('rejectionReasonRequired', 422);
      const inspected = recordQualityInspection({
        reworkId: qualityId,
        executorIds: [],
        inspectorId: actor.id,
        quantity,
        remainingQuantity:
          Number(action.affected_quantity) -
          Number(action.approved_quantity) -
          Number(action.rejected_quantity),
        outcome,
      });
      const approvedQuantity = outcome === 'APPROVED' ? quantity : 0;
      const rejectedQuantity = outcome === 'REJECTED' ? quantity : 0;
      const remainingAfter =
        Number(action.affected_quantity) -
        Number(action.approved_quantity) -
        Number(action.rejected_quantity) -
        quantity;
      const nextStatus =
        remainingAfter > 0
          ? 'OPEN'
          : rejectedQuantity + Number(action.rejected_quantity) > 0
            ? 'REJECTED'
            : 'APPROVED';
      const updated = await this.quality.recordInspection(
        action,
        {
          inspectedBy: actor.id,
          approvedQuantity,
          rejectedQuantity,
          reason: outcome === 'REJECTED' ? reason.trim() : null,
          status: nextStatus,
        },
        { transaction },
      );
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          productItemId: action.product_id,
          actorUserId: actor.id,
          eventType: 'QualityInspectionRecorded',
          payload: {
            qualityId,
            ...inspected,
            approvedQuantity,
            rejectedQuantity,
            inspectionQuantity: quantity,
            inspectorId: actor.id,
            signalId: qualityId,
            reason: outcome === 'REJECTED' ? reason.trim() : null,
            status: nextStatus,
            completedQuantity:
              Number(product?.completed_quantity ?? 0) - rejectedQuantity,
            blockedQuantity:
              Number(product?.blocked_quantity ?? 0) + rejectedQuantity,
          },
        },
        { transaction },
      );
      if (outcome === 'APPROVED') {
        await this.events.append(
          {
            aggregateId: order.id,
            sectorId: order.sector_id,
            productItemId: action.product_id,
            actorUserId: actor.id,
            eventType: 'QualityQuantityApproved',
            payload: { qualityId, quantity: approvedQuantity },
          },
          { transaction },
        );
      }
      if (outcome === 'REJECTED') {
        await this.orders.applyProductProgress(
          product.id,
          {
            completedQuantity:
              Number(product.completed_quantity) - rejectedQuantity,
            blockedQuantity:
              Number(product.blocked_quantity) + rejectedQuantity,
          },
          { transaction },
        );
      }
      if (nextStatus === 'OPEN' || nextStatus === 'REWORK')
        await this.events.append(
          {
            aggregateId: order.id,
            sectorId: order.sector_id,
            productItemId: action.product_id,
            actorUserId: actor.id,
            eventType: 'QualityInspectionPending',
            payload: { qualityId, remainingQuantity: remainingAfter },
          },
          { transaction },
        );
      return updated;
    });
  }

  async triage(orderId, actor) {
    this.assertUser(actor);
    return this.database.connection.transaction(async (transaction) => {
      const order = await this.orders.findById(orderId, {
        transaction,
        lock: true,
      });
      this.assertOrder(order);
      await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
        transaction,
        lock: true,
      });
      await this.permissions.assertPermission(
        actor.id,
        order.sector_id,
        'TRIAGE',
        { transaction, lock: true },
      );
      const outcomes = order.products.map((product) => ({
        productId: product.id,
        outcome: determineProductTriage(product.quantity),
      }));
      if (
        outcomes.some(({ outcome }) => outcome === 'ADMIN_TRIAGE_REQUIRED') &&
        actor.role !== 'admin'
      )
        throw new ServiceOrderApplicationError(
          'administratorTriageRequired',
          403,
        );
      const previous = await this.events.findLatestEvent(
        order.id,
        'ServiceOrderTriaged',
        { transaction },
      );
      if (previous)
        throw new ServiceOrderApplicationError('triageAlreadyCompleted', 409);
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          actorUserId: actor.id,
          eventType: 'ServiceOrderTriaged',
          payload: { products: outcomes },
        },
        { transaction },
      );
      return outcomes;
    });
  }

  async recomputeProductionCompletion(orderId, actorId, transaction) {
    const order = await this.orders.findById(orderId, {
      transaction,
      lock: true,
    });
    if (!order)
      throw new ServiceOrderApplicationError('serviceOrderNotFound', 404);
    const assignments = await this.assignments.getForOrder(orderId, {
      transaction,
    });
    const qualityActions = await this.quality.getForOrder(orderId, {
      transaction,
    });
    const products = order.products.map((product) => {
      const productAssignments = assignments.filter(
        (assignment) => assignment.product_id === product.id,
      );
      const activeAssigned = productAssignments
        .filter((assignment) => assignment.status === 'ACTIVE')
        .reduce(
          (sum, assignment) => sum + Number(assignment.remaining_quantity),
          0,
        );
      const pendingQuality = qualityActions.some(
        (action) =>
          action.product_id === product.id &&
          ['OPEN', 'REWORK'].includes(action.status),
      );
      const rejectedQuantity = qualityActions
        .filter(
          (action) =>
            action.product_id === product.id && action.status === 'REJECTED',
        )
        .reduce((sum, action) => sum + Number(action.rejected_quantity), 0);
      const cycleScope = (order.cycles ?? [])
        .find((cycle) => cycle.active)
        ?.scope?.find((entry) => entry.productId === product.id);
      const required = cycleScope?.quantity ?? Number(product.quantity);
      const approvedRework = qualityActions
        .filter(
          (action) =>
            action.product_id === product.id && action.status === 'APPROVED',
        )
        .reduce((sum, action) => sum + Number(action.approved_quantity), 0);
      return {
        quantity: required,
        completedQuantity: Math.min(
          Number(product.completed_quantity) +
            approvedRework +
            rejectedQuantity,
          required,
        ),
        blockedQuantity: Number(product.blocked_quantity),
        activeAssigned,
        hasPendingQuality: pendingQuality,
      };
    });
    const hasOutstandingAssignments = products.some(
      (product) => product.activeAssigned > 0,
    );
    const completed =
      order.administrative_state === 'ACTIVE' &&
      order.public_status === 'IN_PRODUCTION' &&
      products.length > 0 &&
      !hasOutstandingAssignments &&
      products.every(
        (product) =>
          product.completedQuantity >= product.quantity &&
          product.blockedQuantity === 0 &&
          !product.hasPendingQuality,
      );
    return { completed, products, actorId };
  }

  async advancePublicStatus() {
    throw new ServiceOrderApplicationError(
      'legacyStatusTransitionDisabled',
      409,
    );
  }

  async requestSpecificationRevision(orderId, input, actor) {
    this.assertUser(actor);
    throw new ServiceOrderApplicationError('revisionWorkflowDisabled', 409);
  }

  async decideSpecificationRevision(orderId, input, actor) {
    this.assertUser(actor);
    throw new ServiceOrderApplicationError('revisionWorkflowDisabled', 409);
  }

  async resume(orderId, actor) {
    throw new ServiceOrderApplicationError('operationNotSupported', 409);
  }

  async suspend(orderId, { reason }, actor) {
    throw new ServiceOrderApplicationError('operationNotSupported', 409);
  }

  async assertFullyApproved(order, transaction) {
    const actions = await this.quality.getForOrder(order.id, { transaction });
    const approved =
      order.products?.length > 0 &&
      order.products.every((product) => {
        const productActions = actions.filter(
          (action) => action.product_id === product.id,
        );
        const parents = new Set(
          productActions
            .map((action) => action.parent_quality_id)
            .filter(Boolean),
        );
        const approvedQuantity = productActions.reduce(
          (sum, action) => sum + Number(action.approved_quantity),
          0,
        );
        const unresolved = productActions.some(
          (action) =>
            ['OPEN', 'REWORK'].includes(action.status) ||
            (Number(action.rejected_quantity) > 0 && !parents.has(action.id)),
        );
        return (
          Number(product.quantity) > 0 &&
          approvedQuantity === Number(product.quantity) &&
          Number(product.completed_quantity) === Number(product.quantity) &&
          Number(product.blocked_quantity) === 0 &&
          !unresolved
        );
      });
    if (!approved)
      throw new ServiceOrderApplicationError(
        'productionQualityPrerequisiteRequired',
        409,
      );
  }

  async closeProduction(orderId, { confirmed } = {}, actor) {
    this.assertUser(actor);
    if (confirmed !== true)
      throw new ServiceOrderApplicationError(
        'explicitConfirmationRequired',
        422,
      );
    return this.database.connection.transaction(async (transaction) => {
      const order = await this.orders.findById(orderId, {
        transaction,
        lock: true,
      });
      if (!order)
        throw new ServiceOrderApplicationError('serviceOrderNotFound', 404);
      if (actor.role !== 'admin') {
        await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
          transaction,
          lock: true,
        });
        await this.permissions.assertPermission(
          actor.id,
          order.sector_id,
          'RECORD_QUALITY',
          { transaction, lock: true },
        );
      }
      if (
        order.administrative_state !== 'ACTIVE' ||
        order.functional_status !== 'IN_PRODUCTION' ||
        order.production_completed
      )
        throw new ServiceOrderApplicationError(
          'productionClosureNotAllowed',
          409,
        );
      await this.assertFullyApproved(order, transaction);
      const confirmedAt = new Date().toISOString();
      await order.update(
        { production_completed: true, functional_status: 'AWAITING_DELIVERY' },
        { transaction },
      );
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          actorUserId: actor.id,
          occurredAt: confirmedAt,
          eventType: 'ServiceOrderProductionClosureConfirmed',
          payload: {
            previousStatus: 'IN_PRODUCTION',
            status: 'AWAITING_DELIVERY',
            confirmedBy: actor.id,
            confirmedAt,
          },
        },
        { transaction },
      );
      return {
        functionalStatus: 'AWAITING_DELIVERY',
        productionCompleted: true,
        confirmedAt,
      };
    });
  }

  async setPriority(orderId, { priority } = {}, actor) {
    this.assertUser(actor);
    if (typeof priority !== 'boolean')
      throw new ServiceOrderApplicationError('priorityBooleanRequired', 422);
    return this.database.connection.transaction(async (transaction) => {
      const order = await this.orders.findById(orderId, {
        transaction,
        lock: true,
      });
      if (!order)
        throw new ServiceOrderApplicationError('serviceOrderNotFound', 404);
      if (actor.role !== 'admin') {
        await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
          transaction,
          lock: true,
        });
        await this.assertManagerPermission(
          actor.id,
          order.sector_id,
          'MANAGE_RESPONSIBILITY',
          transaction,
        );
      }
      if (
        ['COMPLETED', 'CANCELLED'].includes(order.functional_status) ||
        ['CLOSED', 'CANCELLED'].includes(order.administrative_state)
      )
        throw new ServiceOrderApplicationError('orderTerminal', 409);
      const previousPriority = Boolean(order.is_priority);
      if (previousPriority === priority)
        throw new ServiceOrderApplicationError('priorityUnchanged', 409);
      const changedAt = new Date().toISOString();
      await order.update(
        {
          is_priority: priority,
          priority_changed_by: actor.id,
          priority_changed_at: changedAt,
        },
        { transaction },
      );
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          actorUserId: actor.id,
          occurredAt: changedAt,
          eventType: 'ServiceOrderPriorityChanged',
          payload: {
            previousPriority,
            priority,
            changedBy: actor.id,
            changedAt,
          },
        },
        { transaction },
      );
      return {
        priority,
        priorityChangedBy: actor.id,
        priorityChangedAt: changedAt,
      };
    });
  }

  async correctProduct(orderId, productId, input, actor) {
    this.assertUser(actor);
    const fields = ['name', 'description', 'measurements', 'quantity'];
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => ![...fields, 'expectedVersion'].includes(key),
      )
    )
      throw new ServiceOrderApplicationError(
        'productCorrectionFieldsInvalid',
        422,
      );
    if (
      typeof input.expectedVersion !== 'string' ||
      !/^\d+$/.test(input.expectedVersion)
    )
      throw new ServiceOrderApplicationError('expectedVersionRequired', 422);
    return this.database.connection.transaction(async (transaction) => {
      const order = await this.orders.findById(orderId, {
        transaction,
        lock: true,
      });
      if (!order)
        throw new ServiceOrderApplicationError('serviceOrderNotFound', 404);
      if (actor.role !== 'admin') {
        await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
          transaction,
          lock: true,
        });
        const manager = await this.permissions.hasPermission(
          actor.id,
          order.sector_id,
          'MANAGE_RESPONSIBILITY',
          { transaction, lock: true },
        );
        if (!manager) {
          if (order.created_by !== actor.id)
            throw new ServiceOrderApplicationError(
              'productCorrectionForbidden',
              403,
            );
          await this.permissions.assertPermission(
            actor.id,
            order.sector_id,
            'CREATE',
            { transaction, lock: true },
          );
        }
      }
      if (
        order.administrative_state !== 'ACTIVE' ||
        order.functional_status !== 'IN_PRODUCTION' ||
        order.production_completed
      )
        throw new ServiceOrderApplicationError(
          'productCorrectionNotAllowed',
          409,
        );
      if (BigInt(input.expectedVersion) !== BigInt(order.operational_version))
        throw new ServiceOrderApplicationError(
          'serviceOrderVersionConflict',
          409,
        );
      const product = order.products.find((entry) => entry.id === productId);
      if (!product)
        throw new ServiceOrderApplicationError('productNotFound', 404);
      const changes = {};
      if (Object.hasOwn(input, 'quantity')) {
        if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0)
          throw new ServiceOrderApplicationError(
            'quantityMustBePositiveInteger',
            422,
          );
        if (input.quantity !== Number(product.quantity))
          throw new ServiceOrderApplicationError(
            'productQuantityImmutable',
            409,
          );
      }
      if (Object.hasOwn(input, 'name')) {
        if (
          typeof input.name !== 'string' ||
          !input.name.trim() ||
          input.name.length > 240
        )
          throw new ServiceOrderApplicationError('productNameRequired', 422);
        changes.name = input.name;
      }
      if (Object.hasOwn(input, 'description')) {
        if (
          input.description !== null &&
          (typeof input.description !== 'string' ||
            input.description.length > 2000)
        )
          throw new ServiceOrderApplicationError(
            'productDescriptionInvalid',
            422,
          );
        changes.description = input.description;
      }
      if (Object.hasOwn(input, 'measurements')) {
        if (
          !input.measurements ||
          typeof input.measurements !== 'object' ||
          Array.isArray(input.measurements)
        )
          throw new ServiceOrderApplicationError('measurementsInvalid', 422);
        changes.measurements = {
          ...product.measurements,
          ...input.measurements,
        };
        validateProductMeasurements(changes.measurements);
      }
      for (const key of Object.keys(changes))
        if (isDeepStrictEqual(product[key] ?? null, changes[key]))
          delete changes[key];
      if (!Object.keys(changes).length)
        throw new ServiceOrderApplicationError(
          'productCorrectionUnchanged',
          409,
        );
      const actions = await this.quality.getForOrder(order.id, {
        transaction,
      });
      if (actions.some((action) => action.product_id === product.id))
        throw new ServiceOrderApplicationError(
          'productCorrectionQualityConflict',
          409,
        );
      const previousValues = {};
      for (const key of Object.keys(changes))
        previousValues[key] = structuredClone(product[key] ?? null);
      const correctedAt = new Date().toISOString();
      await this.orders.correctProduct(product, changes, { transaction });
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          productItemId: product.id,
          actorUserId: actor.id,
          occurredAt: correctedAt,
          eventType: 'ServiceOrderProductCorrected',
          payload: {
            productId: product.id,
            previousValues,
            newValues: changes,
            correctedBy: actor.id,
            correctedAt,
          },
        },
        { transaction },
      );
      return {
        productId: product.id,
        previousValues,
        newValues: changes,
        correctedBy: actor.id,
        correctedAt,
      };
    });
  }

  // The old entry point must not become a confirmation bypass.
  async close(orderId, actor) {
    return this.closeProduction(orderId, {}, actor);
  }

  async complete(orderId, { confirmed, fulfillment } = {}, actor) {
    this.assertUser(actor);
    if (confirmed !== true)
      throw new ServiceOrderApplicationError(
        'explicitConfirmationRequired',
        422,
      );
    if (!['DELIVERY', 'INSTALLATION'].includes(fulfillment))
      throw new ServiceOrderApplicationError(
        'fulfillmentConfirmationInvalid',
        422,
      );
    return this.database.connection.transaction(async (transaction) => {
      const order = await this.orders.findById(orderId, {
        transaction,
        lock: true,
      });
      if (!order)
        throw new ServiceOrderApplicationError('serviceOrderNotFound', 404);
      if (actor.role !== 'admin') {
        await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
          transaction,
          lock: true,
        });
        const manager = await this.permissions.hasPermission(
          actor.id,
          order.sector_id,
          'MANAGE_RESPONSIBILITY',
          { transaction, lock: true },
        );
        if (!manager)
          await this.permissions.assertPermission(
            actor.id,
            order.sector_id,
            'CLOSE',
            { transaction, lock: true },
          );
      }
      if (
        order.administrative_state !== 'ACTIVE' ||
        order.functional_status !== 'AWAITING_DELIVERY' ||
        !order.production_completed
      )
        throw new ServiceOrderApplicationError('completionNotAllowed', 409);
      await this.assertFullyApproved(order, transaction);
      const active = await this.orders.findActiveResponsibility(order.id, {
        transaction,
        lock: true,
      });
      const confirmedAt = new Date().toISOString();
      if (active)
        await this.orders.releaseResponsibility(
          active,
          { actorId: actor.id, reason: `Final confirmation: ${fulfillment}` },
          { transaction },
        );
      await order.update(
        { administrative_state: 'CLOSED', functional_status: 'COMPLETED' },
        { transaction },
      );
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          actorUserId: actor.id,
          occurredAt: confirmedAt,
          eventType: 'ServiceOrderCompletionConfirmed',
          payload: {
            previousStatus: 'AWAITING_DELIVERY',
            status: 'COMPLETED',
            fulfillment,
            confirmedBy: actor.id,
            confirmedAt,
            releasedUserId: active?.user_id ?? null,
            responsibilityId: active?.id ?? null,
          },
        },
        { transaction },
      );
      return {
        functionalStatus: 'COMPLETED',
        fulfillment,
        confirmedAt,
        releasedUserId: active?.user_id ?? null,
      };
    });
  }

  async cancel(orderId, { reason = null } = {}, actor) {
    this.assertUser(actor);
    return this.database.connection.transaction(async (transaction) => {
      const order = await this.orders.findById(orderId, {
        transaction,
        lock: true,
      });
      if (!order)
        throw new ServiceOrderApplicationError('serviceOrderNotFound', 404);
      if (
        order.functional_status === 'COMPLETED' ||
        order.functional_status === 'CANCELLED'
      )
        throw new ServiceOrderApplicationError('orderTerminal', 409);
      if (actor.role !== 'admin')
        await this.requireCurrentSectorGrant(actor.id, order.sector_id, {
          transaction,
          lock: true,
        });
      if (actor.role !== 'admin')
        await this.assertManagerPermission(
          actor.id,
          order.sector_id,
          'CANCEL',
          transaction,
        );
      const decision = cancelServiceOrder(order.administrative_state, {
        authorized: true,
        reason,
      });
      const active = await this.orders.findActiveResponsibility(order.id, {
        transaction,
        lock: true,
      });
      if (active)
        await this.orders.releaseResponsibility(
          active,
          { actorId: actor.id, reason },
          { transaction },
        );
      await order.update(
        { administrative_state: 'CANCELLED', functional_status: 'CANCELLED' },
        { transaction },
      );
      await this.events.append(
        {
          aggregateId: order.id,
          sectorId: order.sector_id,
          actorUserId: actor.id,
          eventType: 'ServiceOrderCancelled',
          payload: {
            ...decision,
            reason:
              typeof reason === 'string' && reason.trim()
                ? reason.trim()
                : null,
            releasedUserId: active?.user_id ?? null,
          },
        },
        { transaction },
      );
      return { functionalStatus: 'CANCELLED' };
    });
  }

  async reopen(orderId, { reason, scope }, actor) {
    throw new ServiceOrderApplicationError('operationNotSupported', 409);
  }

  async getInternal(orderId, actor) {
    this.assertUser(actor);
    const order = await this.orders.findById(orderId);
    this.assertOrder(order, { readOnly: true });
    if (actor.role !== 'admin')
      await this.requireCurrentSectorGrant(actor.id, order.sector_id);
    await this.permissions.assertPermission(
      actor.id,
      order.sector_id,
      'READ_INTERNAL',
    );
    return order;
  }

  async getQueue(sectorId, actor, { limit = 50, cursor } = {}) {
    this.assertUser(actor);
    if (!sectorId)
      throw new ServiceOrderApplicationError('sectorRequired', 422);
    if (actor.role !== 'admin')
      await this.requireCurrentSectorGrant(actor.id, sectorId);
    await this.permissions.assertPermission(
      actor.id,
      sectorId,
      'READ_INTERNAL',
    );
    const secret = process.env.SERVICE_ORDER_CURSOR_SECRET;
    if (!secret)
      throw new ServiceOrderApplicationError('queueCursorUnavailable', 503);
    const pageLimit = Math.min(
      Math.max(Number.parseInt(limit, 10) || 50, 1),
      100,
    );
    const state = cursor
      ? this.parseQueueCursor(cursor, secret, sectorId, actor.id)
      : {};
    const rows = await this.orders.findQueuePage(sectorId, {
      limit: pageLimit + 1,
      afterQueuedAt: state.queuedAt,
      afterId: state.id,
    });
    const hasMore = rows.length > pageLimit;
    const orders = rows.slice(0, pageLimit);
    const last = orders.at(-1);
    const nextCursor =
      hasMore && last
        ? this.createQueueCursor(secret, {
            sectorId,
            scope: actor.id,
            queuedAt: last.queue_entered_at.toISOString(),
            id: last.id,
          })
        : null;
    return { orders, nextCursor };
  }

  createQueueCursor(secret, payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret)
      .update(encoded)
      .digest('base64url');
    return `${encoded}.${signature}`;
  }

  parseQueueCursor(cursor, secret, sectorId, actorId) {
    try {
      const [encoded, signature, extra] = String(cursor).split('.');
      if (!encoded || !signature || extra) throw new Error('format');
      const expected = createHmac('sha256', secret).update(encoded).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new Error('signature');
      const value = JSON.parse(Buffer.from(encoded, 'base64url').toString());
      if (value.sectorId !== sectorId || value.scope !== actorId)
        throw new Error('scope');
      if (value.sectorId === 'CLIENT_ORDERS') {
        if (!Number.isFinite(Date.parse(value.createdAt)) || !value.id)
          throw new Error('payload');
      } else if (!Number.isFinite(Date.parse(value.queuedAt)) || !value.id) {
        throw new Error('payload');
      }
      return value;
    } catch {
      throw new ServiceOrderApplicationError('queueCursorInvalid', 400);
    }
  }

  async requireCurrentSectorGrant(
    userId,
    sectorId,
    { transaction, lock = false } = {},
  ) {
    const allowed =
      lock && transaction
        ? await this.orders.lockSectorGrant(userId, sectorId, {
            transaction,
            lock: transaction.LOCK.SHARE,
          })
        : await this.orders.hasUserSectorGrant(userId, sectorId, {
            transaction,
          });
    if (!allowed)
      throw new ServiceOrderApplicationError('sectorGrantRequired', 403);
  }

  async getClientOrders(clientId, query, actor) {
    if (actor?.type !== 'client' || actor.id !== clientId)
      throw new ServiceOrderApplicationError('clientOwnershipRequired', 403);
    if (!this.readService)
      throw new ServiceOrderApplicationError(
        'clientReadServiceUnavailable',
        503,
      );
    return this.readService.getClientOrders({
      clientId,
      actor,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  async configurePermission(data, actor) {
    this.assertUser(actor);
    if (actor.role !== 'admin') {
      await this.requireCurrentSectorGrant(actor.id, data.sectorId);
      if (data.operation !== 'CREATE')
        throw new ServiceOrderApplicationError('managerGrantRestricted', 403);
      await this.assertManagerPermission(
        actor.id,
        data.sectorId,
        'MANAGE_RESPONSIBILITY',
      );
    }
    if (data.userId === actor.id)
      throw new ServiceOrderApplicationError('selfGrantForbidden', 403);
    return this.database.connection.transaction(async (transaction) => {
      if (
        !(await this.orders.lockSectorMembership(data.userId, data.sectorId, {
          transaction,
        }))
      )
        throw new ServiceOrderApplicationError(
          'targetSectorGrantRequired',
          409,
        );
      const operations =
        actor.role === 'admin' && data.operation === 'MANAGE_RESPONSIBILITY'
          ? SECTOR_MANAGER_OPERATIONS
          : [data.operation];
      const permissions = [];
      for (const operation of operations)
        permissions.push(
          await this.permissions.grant(
            { ...data, operation, actorId: actor.id },
            { transaction },
          ),
        );
      return permissions.length === 1 ? permissions[0] : permissions;
    });
  }

  async revokePermission(grantId, { reason }, actor) {
    this.assertUser(actor);
    return this.database.connection.transaction(async (transaction) => {
      const grant = await this.permissions.findGrant(grantId, {
        transaction,
        lock: true,
      });
      if (!grant) throw new ServiceOrderApplicationError('grantNotFound', 404);
      if (actor.role !== 'admin') {
        await this.requireCurrentSectorGrant(actor.id, grant.sector_id, {
          transaction,
          lock: true,
        });
        await this.assertManagerPermission(
          actor.id,
          grant.sector_id,
          'MANAGE_RESPONSIBILITY',
          transaction,
        );
        if (grant.operation !== 'CREATE')
          throw new ServiceOrderApplicationError('managerGrantRestricted', 403);
      }
      return this.permissions.revoke(
        { grantId, actorId: actor.id, reason },
        { transaction },
      );
    });
  }

  async assertManagerPermission(userId, sectorId, operation, transaction) {
    const allowed = this.permissions.hasPermission
      ? await this.permissions.hasPermission(userId, sectorId, operation, {
          transaction,
          lock: Boolean(transaction),
        })
      : await this.permissions
          .assertPermission(userId, sectorId, operation, {
            transaction,
            lock: Boolean(transaction),
          })
          .then(() => true);
    if (!allowed)
      throw new ServiceOrderApplicationError('managerPermissionRequired', 403);
  }

  async assertSectorOperation(userId, sectorId, operation, transaction) {
    if (!this.permissions.hasPermission)
      return this.permissions.assertPermission(userId, sectorId, operation, {
        transaction,
        lock: Boolean(transaction),
      });
    const isManager = await this.permissions.hasPermission(
      userId,
      sectorId,
      'MANAGE_RESPONSIBILITY',
      {
        transaction,
        lock: Boolean(transaction),
      },
    );
    if (isManager && SECTOR_MANAGER_OPERATIONS.includes(operation)) return;
    await this.permissions.assertPermission(userId, sectorId, operation, {
      transaction,
      lock: Boolean(transaction),
    });
  }

  async changeAdministrativeState(
    orderId,
    actor,
    operation,
    decide,
    payload = {},
  ) {
    return { disabled: true };
  }

  assertUser(actor) {
    if (actor?.type !== 'user' || typeof actor.id !== 'string' || !actor.id)
      throw new ServiceOrderApplicationError('authenticatedUserRequired', 401);
  }

  assertOrder(order, { readOnly = false } = {}) {
    if (!order)
      throw new ServiceOrderApplicationError('serviceOrderNotFound', 404);
    if (order.administrative_state === 'CANCELLED')
      throw new ServiceOrderApplicationError('serviceOrderCancelled', 409);
    if (
      !readOnly &&
      (order.functional_status === 'COMPLETED' ||
        order.administrative_state === 'CLOSED')
    )
      throw new ServiceOrderApplicationError('orderNotActive', 409);
  }
}

export default ServiceOrderService;

export const serviceOrderService = new ServiceOrderService({
  database: Database,
  orders: ServiceOrderRepository,
  events: ServiceOrderEventRepository,
  permissions: ServiceOrderPermissionRepository,
  assignments: ServiceOrderAssignmentRepository,
  quality: ServiceOrderQualityRepository,
  readService: new ServiceOrderReadService(),
});
