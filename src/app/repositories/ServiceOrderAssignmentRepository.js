import { randomUUID } from 'node:crypto';
import ServiceOrderAssignment from '../models/ServiceOrderAssignment.js';
import ServiceOrder from '../models/ServiceOrder.js';
import ServiceOrderProduct from '../models/ServiceOrderProduct.js';

class ServiceOrderAssignmentRepository {
  async create(data, { transaction } = {}) {
    this.requireTransaction(transaction);
    const order = await ServiceOrder.findByPk(data.orderId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order || order.sector_id !== data.sectorId)
      throw new Error('ServiceOrder assignment sector/order mismatch');
    return ServiceOrderAssignment.create(
      {
        id: randomUUID(),
        service_order_id: data.orderId,
        product_id: data.productId,
        sector_id: data.sectorId,
        assigned_user_id: data.assignedUserId,
        assigned_by: data.assignedBy,
        quantity: data.quantity,
        executed_quantity: 0,
        remaining_quantity: data.quantity,
        status: 'ACTIVE',
        created_at: new Date(),
      },
      { transaction },
    );
  }

  getActiveForProduct(productId, { transaction } = {}) {
    return ServiceOrderAssignment.findAll({
      where: { product_id: productId, status: 'ACTIVE' },
      transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  async findActiveForProduct(productId, { transaction } = {}) {
    this.requireTransaction(transaction);
    const product = await ServiceOrderProduct.findByPk(productId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!product) throw new Error('ServiceOrder product not found');
    return this.getActiveForProduct(productId, { transaction });
  }

  async sumActiveForProduct(productId, { transaction } = {}) {
    this.requireTransaction(transaction);
    const product = await ServiceOrderProduct.findByPk(productId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!product) throw new Error('ServiceOrder product not found');
    const result = await ServiceOrderAssignment.sum('remaining_quantity', {
      where: { product_id: productId, status: 'ACTIVE' },
      transaction,
    });
    return Number(result ?? 0);
  }

  findById(id, { transaction } = {}) {
    return ServiceOrderAssignment.findByPk(id, {
      transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  getForOrder(orderId, { transaction } = {}) {
    return ServiceOrderAssignment.findAll({
      where: { service_order_id: orderId },
      order: [
        ['created_at', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction,
    });
  }

  async recordExecution(assignment, { quantity }, { transaction } = {}) {
    this.requireTransaction(transaction);
    if (assignment.status !== 'ACTIVE')
      throw new Error('Only active ServiceOrder assignments can be executed');
    const remaining = Number(assignment.remaining_quantity) - quantity;
    const executed = Number(assignment.executed_quantity) + quantity;
    const status = remaining === 0 ? 'COMPLETED' : 'ACTIVE';
    return assignment.update(
      {
        executed_quantity: executed,
        remaining_quantity: remaining,
        status,
      },
      { transaction },
    );
  }

  async release(assignment, { actorId }, { transaction } = {}) {
    this.requireTransaction(transaction);
    if (assignment.status !== 'ACTIVE')
      throw new Error('Only active ServiceOrder assignments can be released');
    const executed = Number(assignment.executed_quantity);
    const remaining = Number(assignment.remaining_quantity);
    const released = await assignment.update(
      {
        quantity: executed,
        remaining_quantity: 0,
        status: 'RELEASED',
      },
      { transaction },
    );
    return { assignment: released, releasedQuantity: remaining, actorId };
  }

  async reassign(
    assignment,
    { assignedUserId, actorId, quantity },
    { transaction } = {},
  ) {
    this.requireTransaction(transaction);
    if (assignment.status !== 'ACTIVE')
      throw new Error('Only active ServiceOrder assignments can be reassigned');
    const remaining = Number(assignment.remaining_quantity);
    const executed = Number(assignment.executed_quantity);
    if (remaining === 0)
      throw new Error('Completed assignments cannot be reassigned');
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > remaining)
      throw new Error(
        'Reassignment quantity must be within the unexecuted amount',
      );
    const replacement = await this.create(
      {
        orderId: assignment.service_order_id,
        productId: assignment.product_id,
        sectorId: assignment.sector_id,
        assignedUserId,
        assignedBy: actorId,
        quantity,
      },
      { transaction },
    );
    await assignment.update(
      {
        quantity: executed + quantity,
        remaining_quantity: 0,
        status: 'REASSIGNED',
      },
      { transaction },
    );
    return replacement;
  }

  requireTransaction(transaction) {
    if (!transaction)
      throw new Error('ServiceOrder assignment requires a transaction');
  }
}

export default new ServiceOrderAssignmentRepository();
