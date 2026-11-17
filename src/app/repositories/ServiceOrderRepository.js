import ServiceOrder from '../models/ServiceOrder.js';
import ServiceOrderProduct from '../models/ServiceOrderProduct.js';
import ServiceOrderAssignment from '../models/ServiceOrderAssignment.js';
import ServiceOrderCycle from '../models/ServiceOrderCycle.js';
import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';
import UserSector from '../models/UserSector.js';
import ServiceOrderResponsibility from '../models/ServiceOrderResponsibility.js';

class ServiceOrderRepository {
  async create(data, { transaction, products = [] } = {}) {
    if (!transaction)
      throw new Error('ServiceOrder creation requires an explicit transaction');
    const externalNumber = data.externalNumber ?? data.orderNumber;
    if (typeof externalNumber !== 'string' || !externalNumber.trim())
      throw new Error('ServiceOrder external number is required');
    if (!data.sectorId) throw new Error('ServiceOrder sector is required');
    const orderId = data.id ?? randomUUID();
    if (typeof data.dueAt !== 'string' || Number.isNaN(Date.parse(data.dueAt)))
      throw new Error('ServiceOrder due date must be valid');
    const order = await ServiceOrder.create(
      {
        id: orderId,
        external_number: externalNumber,
        client_id: data.clientId,
        sector_id: data.sectorId,
        due_at: data.dueAt,
        notes: data.notes ?? null,
        public_status: data.publicStatus ?? 'CREATED',
        functional_status: 'REGISTERED',
        administrative_state: 'ACTIVE',
        operational_version: '0',
        queue_entered_at: data.queueEnteredAt ?? new Date(),
        production_completed: false,
        created_by: data.createdBy,
      },
      { transaction },
    );
    if (products.length) {
      await ServiceOrderProduct.bulkCreate(
        products.map((product) => ({
          id: product.id ?? randomUUID(),
          service_order_id: order.id,
          name: product.name,
          description: product.description ?? null,
          quantity: product.quantity,
          unit_code: 'UN',
          measurements: product.measurements ?? {},
          specification_revision: 1,
          completed_quantity: 0,
          blocked_quantity: 0,
        })),
        { transaction },
      );
    }
    order.products = await ServiceOrderProduct.findAll({
      where: { service_order_id: orderId },
      transaction,
    });
    return order;
  }

  findById(id, { transaction, lock } = {}) {
    return ServiceOrder.findByPk(id, {
      transaction,
      ...(lock && transaction
        ? { lock: { level: transaction.LOCK.UPDATE, of: ServiceOrder } }
        : {}),
      include: [
        { model: ServiceOrderProduct, as: 'products' },
        { model: ServiceOrderCycle, as: 'cycles' },
      ],
    });
  }

  async findScopedById(id, sectorId, { transaction, lock = false } = {}) {
    if (!sectorId) throw new Error('ServiceOrder sector scope is required');
    const order = await ServiceOrder.findOne({
      where: { id, sector_id: sectorId },
      transaction,
      ...(lock && transaction
        ? { lock: { level: transaction.LOCK.UPDATE, of: ServiceOrder } }
        : {}),
      include: [
        { model: ServiceOrderProduct, as: 'products' },
        { model: ServiceOrderCycle, as: 'cycles' },
      ],
    });
    return order;
  }

  findBySectorAndExternalNumber(
    sectorId,
    externalNumber,
    { transaction, lock = false } = {},
  ) {
    return ServiceOrder.findOne({
      where: { sector_id: sectorId, external_number: externalNumber },
      transaction,
      ...(lock && transaction
        ? { lock: { level: transaction.LOCK.UPDATE, of: ServiceOrder } }
        : {}),
      include: [{ model: ServiceOrderProduct, as: 'products' }],
    });
  }

  findActiveResponsibility(orderId, { transaction, lock = false } = {}) {
    return ServiceOrderResponsibility.findOne({
      where: { service_order_id: orderId, released_at: null },
      transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  findActiveResponsibilityForUser(userId, { transaction, lock = false } = {}) {
    return ServiceOrderResponsibility.findOne({
      where: { user_id: userId, released_at: null },
      transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  async assignResponsibility(
    { orderId, userId, actorId },
    { transaction } = {},
  ) {
    if (!transaction)
      throw new Error('Responsibility assignment requires a transaction');
    return ServiceOrderResponsibility.create(
      {
        id: randomUUID(),
        service_order_id: orderId,
        user_id: userId,
        assigned_by: actorId,
        assigned_at: new Date(),
        released_by: null,
        released_at: null,
      },
      { transaction },
    );
  }

  async releaseResponsibility(
    responsibility,
    { actorId, reason = null },
    { transaction } = {},
  ) {
    if (!transaction)
      throw new Error('Responsibility release requires a transaction');
    return responsibility.update(
      { released_by: actorId, released_at: new Date(), release_reason: reason },
      { transaction },
    );
  }

  getProducts(orderId, { transaction } = {}) {
    return ServiceOrderProduct.findAll({
      where: { service_order_id: orderId },
      order: [
        ['created_at', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction,
    });
  }

  correctProduct(product, changes, { transaction } = {}) {
    if (!transaction)
      throw new Error('Product correction requires a transaction');
    if (
      Object.keys(changes).some(
        (key) => !['name', 'description', 'measurements'].includes(key),
      )
    )
      throw new Error(
        'Product correction cannot change composition or quantity',
      );
    return product.update(changes, { transaction });
  }

  findQueue(sectorId, { transaction, limit = 100 } = {}) {
    return ServiceOrder.findAll({
      where: { sector_id: sectorId, administrative_state: 'ACTIVE' },
      order: [
        ['queue_entered_at', 'ASC'],
        ['id', 'ASC'],
      ],
      limit,
      transaction,
      include: [{ model: ServiceOrderProduct, as: 'products' }],
    });
  }

  findQueuePage(
    sectorId,
    { transaction, limit = 50, afterQueuedAt, afterId } = {},
  ) {
    if (!sectorId) throw new Error('ServiceOrder queue sector is required');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error(
        'ServiceOrder queue page limit must be between 1 and 100',
      );
    const where = { sector_id: sectorId, administrative_state: 'ACTIVE' };
    if (afterQueuedAt !== undefined) {
      if (!afterId) throw new Error('ServiceOrder queue cursor is incomplete');
      where[Op.or] = [
        { queue_entered_at: { [Op.gt]: afterQueuedAt } },
        {
          queue_entered_at: afterQueuedAt,
          id: { [Op.gt]: afterId },
        },
      ];
    }
    return ServiceOrder.findAll({
      where,
      order: [
        ['queue_entered_at', 'ASC'],
        ['id', 'ASC'],
      ],
      limit: limit + 1,
      transaction,
      include: [{ model: ServiceOrderProduct, as: 'products' }],
    });
  }

  findForClient(
    clientId,
    { transaction, afterCreatedAt, afterId, limit = 50 } = {},
  ) {
    const where = { client_id: clientId };
    if (afterCreatedAt && afterId) {
      where[Op.or] = [
        { created_at: { [Op.lt]: afterCreatedAt } },
        { created_at: afterCreatedAt, id: { [Op.lt]: afterId } },
      ];
    }
    return ServiceOrder.findAll({
      where,
      order: [
        ['created_at', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
      transaction,
    });
  }

  updateAdministrativeState(id, state, { transaction } = {}) {
    if (!transaction)
      throw new Error('ServiceOrder state update requires a transaction');
    return ServiceOrder.update(
      { administrative_state: state },
      { where: { id }, transaction },
    );
  }

  async updateProductionCompleted(id, completed, { transaction } = {}) {
    if (!transaction)
      throw new Error('ServiceOrder completion requires a transaction');
    await ServiceOrder.update(
      { production_completed: completed },
      { where: { id }, transaction },
    );
  }

  applyProductProgress(
    productId,
    { completedQuantity, blockedQuantity },
    { transaction } = {},
  ) {
    if (!transaction)
      throw new Error('ServiceOrder product progress requires a transaction');
    return ServiceOrderProduct.update(
      {
        completed_quantity: completedQuantity,
        blocked_quantity: blockedQuantity,
      },
      { where: { id: productId }, transaction },
    );
  }

  async lockProduct(productId, { transaction } = {}) {
    if (!transaction) throw new Error('Product lock requires a transaction');
    return ServiceOrderProduct.findByPk(productId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  findAssignmentsForProduct(productId, { transaction, lock = false } = {}) {
    return ServiceOrderAssignment.findAll({
      where: { product_id: productId, status: 'ACTIVE' },
      transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  async hasUserSectorGrant(userId, sectorId, { transaction } = {}) {
    return Boolean(
      await UserSector.findOne({
        where: { user_id: userId, sector_id: sectorId },
        transaction,
      }),
    );
  }

  async lockSectorGrant(userId, sectorId, { transaction } = {}) {
    if (!transaction)
      throw new Error('Current sector grant check requires a transaction');
    const grant = await UserSector.findOne({
      where: { user_id: userId, sector_id: sectorId },
      transaction,
      lock: transaction.LOCK.SHARE,
    });
    return Boolean(grant);
  }

  async lockSectorMembership(userId, sectorId, { transaction } = {}) {
    if (!transaction)
      throw new Error('Sector membership check requires a transaction');
    const grant = await UserSector.findOne({
      where: { user_id: userId, sector_id: sectorId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    return Boolean(grant);
  }

  async lockUserSectorMembership(userId, sectorId, { transaction } = {}) {
    if (!transaction)
      throw new Error('Sector membership lock requires a transaction');
    return UserSector.findOne({
      where: { user_id: userId, sector_id: sectorId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  async lockUserResponsibility(userId, { transaction } = {}) {
    if (!transaction)
      throw new Error('Responsibility lock requires a transaction');
    await ServiceOrder.sequelize.query(
      'SELECT pg_advisory_xact_lock(hashtext(:lock_key))',
      {
        replacements: { lock_key: `service-order-responsibility:${userId}` },
        transaction,
      },
    );
  }

  async createCycle(orderId, cycle, { transaction } = {}) {
    if (!transaction)
      throw new Error('ServiceOrder cycle creation requires a transaction');
    if (!cycle || !Array.isArray(cycle.scope) || !cycle.scope.length)
      throw new Error('ServiceOrder cycle requires an explicit scope');
    return ServiceOrderCycle.create(
      {
        id: randomUUID(),
        service_order_id: orderId,
        cycle_number: cycle.number,
        reason: cycle.reason,
        reopened_by: cycle.reopenedBy,
        scope: cycle.scope,
        active: true,
        created_at: new Date(),
        closed_at: null,
      },
      { transaction },
    );
  }
}

export default new ServiceOrderRepository();
