import ServiceOrderQuality from '../models/ServiceOrderQuality.js';
import ServiceOrder from '../models/ServiceOrder.js';
import ServiceOrderProduct from '../models/ServiceOrderProduct.js';
import { randomUUID } from 'node:crypto';

class ServiceOrderQualityRepository {
  async create(data, { transaction } = {}) {
    this.requireTransaction(transaction);
    return ServiceOrderQuality.create(
      {
        id: randomUUID(),
        service_order_id: data.orderId,
        product_id: data.productId,
        parent_quality_id: data.parentQualityId ?? null,
        reported_by: data.reportedBy,
        inspected_by: null,
        rework_executor_id: null,
        inspection_history: [],
        issue: data.issue ?? 'Sinalizado para conferência de qualidade',
        disposition: null,
        affected_quantity: data.quantity,
        approved_quantity: 0,
        rejected_quantity: 0,
        status: 'OPEN',
        created_at: new Date(),
      },
      { transaction },
    );
  }

  findById(id, { transaction, lock = false } = {}) {
    return ServiceOrderQuality.findByPk(id, {
      transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  getForOrder(orderId, { transaction } = {}) {
    return ServiceOrderQuality.findAll({
      where: { service_order_id: orderId },
      order: [
        ['created_at', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction,
    });
  }

  findPendingBySector(sectorId, { transaction } = {}) {
    return ServiceOrderQuality.findAll({
      where: { status: ['OPEN', 'REWORK'] },
      include: [
        {
          model: ServiceOrder,
          as: 'serviceOrder',
          required: true,
          where: { sector_id: sectorId },
        },
      ],
      order: [
        ['created_at', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction,
    });
  }

  async findActiveForProduct(productId, { transaction } = {}) {
    return ServiceOrderQuality.findOne({
      where: { product_id: productId, status: ['OPEN', 'REWORK'] },
      order: [['created_at', 'ASC']],
      transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  async findActiveForProductUpdate(productId, { transaction } = {}) {
    this.requireTransaction(transaction);
    const product = await ServiceOrderProduct.findByPk(productId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!product) throw new Error('ServiceOrder product not found');
    return ServiceOrderQuality.findOne({
      where: { product_id: productId, status: 'OPEN' },
      order: [
        ['created_at', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }

  async decide(action, data, { transaction } = {}) {
    this.requireTransaction(transaction);
    if (action.disposition)
      throw new Error(
        'ServiceOrder quality disposition is immutable once decided',
      );
    return action.update(
      {
        disposition: data.disposition,
        status: data.status,
        ...(data.reworkExecutorId
          ? { rework_executor_id: data.reworkExecutorId }
          : {}),
      },
      { transaction },
    );
  }

  async recordInspection(action, data, { transaction } = {}) {
    this.requireTransaction(transaction);
    if (action.status !== 'OPEN')
      throw new Error('Only unresolved ServiceOrder quality can be inspected');
    const approvedQuantity = Number(action.approved_quantity);
    const rejectedQuantity = Number(action.rejected_quantity);
    const affectedQuantity = Number(action.affected_quantity);
    if (
      !Number.isSafeInteger(data.approvedQuantity) ||
      !Number.isSafeInteger(data.rejectedQuantity) ||
      data.approvedQuantity < 0 ||
      data.rejectedQuantity < 0 ||
      data.approvedQuantity + data.rejectedQuantity <= 0 ||
      approvedQuantity +
        rejectedQuantity +
        data.approvedQuantity +
        data.rejectedQuantity >
        affectedQuantity
    )
      throw new Error(
        'ServiceOrder inspection quantity exceeds affected quantity',
      );
    const history = Array.isArray(action.inspection_history)
      ? action.inspection_history
      : [];
    return action.update(
      {
        inspected_by: data.inspectedBy,
        approved_quantity: approvedQuantity + data.approvedQuantity,
        rejected_quantity: rejectedQuantity + data.rejectedQuantity,
        status: data.status,
        inspection_history: [
          ...history,
          {
            inspectorId: data.inspectedBy,
            approvedQuantity: data.approvedQuantity,
            rejectedQuantity: data.rejectedQuantity,
            status: data.status,
            reason: data.reason ?? null,
            occurredAt: new Date().toISOString(),
          },
        ],
      },
      { transaction },
    );
  }

  async addInspectionHistory(action, entry, { transaction } = {}) {
    this.requireTransaction(transaction);
    return action.update(
      { inspection_history: [...(action.inspection_history ?? []), entry] },
      { transaction },
    );
  }

  requireTransaction(transaction) {
    if (!transaction)
      throw new Error('ServiceOrder quality operation requires a transaction');
  }
}

export default new ServiceOrderQualityRepository();
