import ServiceOrderEvent from '../models/ServiceOrderEvent.js';
import ServiceOrderOutbox from '../models/ServiceOrderOutbox.js';
import ServiceOrder from '../models/ServiceOrder.js';
import ServiceOrderProduct from '../models/ServiceOrderProduct.js';
import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';

class ServiceOrderEventRepository {
  async append(event, { transaction, enqueue = true, expectedVersion } = {}) {
    if (!transaction)
      throw new Error(
        'ServiceOrder event append requires an explicit transaction',
      );
    if (!event?.aggregateId || !event?.sectorId || !event?.eventType)
      throw new Error(
        'ServiceOrder event is missing required aggregate fields',
      );
    const aggregate = await ServiceOrder.findByPk(event.aggregateId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!aggregate) throw new Error('ServiceOrder aggregate not found');
    if (aggregate.sector_id !== event.sectorId)
      throw new Error('ServiceOrder event sector does not match its aggregate');
    if (
      event.productItemId &&
      !(await ServiceOrderProduct.findOne({
        where: { id: event.productItemId, service_order_id: event.aggregateId },
        transaction,
      }))
    )
      throw new Error(
        'ServiceOrder event product does not belong to its aggregate',
      );

    const version = BigInt(aggregate.operational_version) + 1n;
    if (expectedVersion !== undefined && BigInt(expectedVersion) !== version)
      throw new Error('ServiceOrder event aggregate version is not contiguous');
    const occurredAt = event.occurredAt
      ? new Date(event.occurredAt)
      : new Date();
    if (!Number.isFinite(occurredAt.getTime()))
      throw new Error('ServiceOrder event occurredAt must be valid');
    const eventId = event.eventId ?? randomUUID();
    const row = await ServiceOrderEvent.create(
      {
        event_id: eventId,
        aggregate_id: event.aggregateId,
        aggregate_version: version.toString(),
        schema_version: event.schemaVersion ?? 1,
        event_type: event.eventType,
        actor_user_id: event.actorUserId ?? null,
        sector_id: event.sectorId,
        product_item_id: event.productItemId ?? null,
        revision: event.revision ?? null,
        cycle: event.cycle ?? null,
        correlation_id: event.correlationId ?? null,
        payload: event.payload ?? {},
        occurred_at: occurredAt,
      },
      { transaction },
    );
    await aggregate.update(
      { operational_version: version.toString() },
      { transaction },
    );
    if (enqueue) {
      const envelope = {
        schemaVersion: event.schemaVersion ?? 1,
        eventId,
        aggregateType: 'SERVICE_ORDER',
        aggregateId: event.aggregateId,
        aggregateVersion: version.toString(),
        eventType: event.eventType,
        occurredAt: occurredAt.toISOString(),
        actor: event.actorUserId
          ? { type: 'USER', id: event.actorUserId }
          : null,
        correlationId: event.correlationId ?? null,
        sectorId: event.sectorId,
        productItemId: event.productItemId ?? null,
        revision: event.revision ?? null,
        cycle: event.cycle ?? null,
        payload: event.payload ?? {},
      };
      await ServiceOrderOutbox.create(
        {
          event_id: eventId,
          aggregate_id: event.aggregateId,
          aggregate_version: version.toString(),
          schema_version: event.schemaVersion ?? 1,
          event_type: event.eventType,
          payload: envelope,
          status: 'PENDING',
          attempts: 0,
          available_at: new Date(),
          created_at: new Date(),
        },
        { transaction },
      );
    }
    return row;
  }

  findByAggregate(
    aggregateId,
    { afterVersion = '0', throughVersion, limit = 500, transaction } = {},
  ) {
    const where = { aggregate_id: aggregateId };
    where.aggregate_version = { [Op.gt]: String(afterVersion) };
    if (throughVersion !== undefined)
      where.aggregate_version[Op.lte] = String(throughVersion);
    return ServiceOrderEvent.findAll({
      where,
      order: [['aggregate_version', 'ASC']],
      limit,
      transaction,
    });
  }

  async getAggregateSummary(aggregateId, { transaction } = {}) {
    const rows = await ServiceOrderEvent.findAll({
      where: { aggregate_id: aggregateId },
      order: [['aggregate_version', 'ASC']],
      transaction,
    });
    const summary = {
      reworkExecutorsByQualityId: {},
      executionsByAssignment: {},
    };
    for (const row of rows) {
      const payload = row.payload ?? {};
      if (row.event_type === 'WorkProgressRecorded' && payload.assignmentId) {
        summary.executionsByAssignment[payload.assignmentId] ??= [];
        if (row.actor_user_id) {
          const actors = summary.executionsByAssignment[payload.assignmentId];
          if (!actors.includes(row.actor_user_id))
            actors.push(row.actor_user_id);
        }
        if (payload.qualityId) {
          summary.reworkExecutorsByQualityId[payload.qualityId] ??= [];
          const qualityActors =
            summary.reworkExecutorsByQualityId[payload.qualityId];
          if (!qualityActors.includes(row.actor_user_id))
            qualityActors.push(row.actor_user_id);
        }
      }
      if (
        row.event_type === 'QualityDispositionRecorded' &&
        payload.disposition === 'REWORK' &&
        payload.reworkExecutorId
      )
        summary.reworkExecutorsByQualityId[payload.qualityId] = [
          payload.reworkExecutorId,
        ];
    }
    return summary;
  }

  async findLatestEvent(aggregateId, eventType, { transaction } = {}) {
    return ServiceOrderEvent.findOne({
      where: { aggregate_id: aggregateId, event_type: eventType },
      order: [['aggregate_version', 'DESC']],
      transaction,
    });
  }

  findFirstMatchingType(aggregateId, eventType, { transaction } = {}) {
    return ServiceOrderEvent.findOne({
      where: { aggregate_id: aggregateId, event_type: eventType },
      order: [['aggregate_version', 'ASC']],
      transaction,
    });
  }
}

export default new ServiceOrderEventRepository();
