import InventoryEvent from '../models/InventoryEvent.js'
import { Op } from 'sequelize'
import Database from '../../database/index.js'
import InventoryOutboxService from '../services/InventoryOutboxService.js'

class InventoryEventRepository {
  async create(data, transaction) {
    if (!transaction) throw new Error('InventoryEvent requires an explicit PostgreSQL transaction')
    const event = await InventoryEvent.create(data, { transaction })
    await InventoryOutboxService.record(event, transaction)
    const { default: InventorySnapshotService } = await import('../services/InventorySnapshotService.js')
    await InventorySnapshotService.createIfDue(event.material_id, { transaction, latestEvent: event })
    return event
  }
  findById(id, options = {}) { return InventoryEvent.findByPk(id, options) }
  findLatestForMaterial(materialId, transaction) {
    return InventoryEvent.findOne({ where: { material_id: materialId }, order: [['sequence', 'DESC']], transaction })
  }
  countForMaterial(materialId, transaction) {
    return InventoryEvent.count({ where: { material_id: materialId }, transaction })
  }
  findById(id, transaction) { return InventoryEvent.findByPk(id, { transaction }) }
  findEventsForRebuild(materialId, afterVersion = '0', throughVersion, transaction, limit = 500) {
    const where = { material_id: materialId }
    where.sequence = { [Op.gt]: afterVersion }
    if (throughVersion !== undefined) where.sequence[Op.lte] = throughVersion
    return InventoryEvent.findAll({ where, order: [['sequence', 'ASC']], limit, transaction })
  }
  findByMaterialVersion(materialId, sequence, transaction) {
    return InventoryEvent.findOne({ where: { material_id: materialId, sequence }, transaction })
  }
  findByIdForUpdate(id, transaction) {
    return InventoryEvent.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE })
  }
  findReturnsForUpdate(originalEventId, transaction) {
    return InventoryEvent.findAll({
      where: { return_of_event_id: originalEventId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    })
  }
  findCompensations(originalEventId, transaction) {
    return InventoryEvent.findAll({ where: { compensates_event_id: originalEventId }, transaction })
  }
  async summarizeByPeriod({ from, to, warehouseId, sectorIds, materialId, actors = {}, type, transaction }) {
    const replacements = {
      from, to, warehouseId: warehouseId ?? null, materialId: materialId ?? null,
      hasSectorFilter: sectorIds !== null && sectorIds !== undefined,
      sectorIds: sectorIds?.length ? `{${sectorIds.join(',')}}` : '{}',
      withdrawnBy: actors.withdrawnBy ?? null, receivedBy: actors.receivedBy ?? null,
      performedBy: actors.performedBy ?? null, authorizedBy: actors.authorizedBy ?? null, type: type ?? null,
    }
    return Database.connection.query(`
      WITH scoped_materials AS (
        SELECT m.id AS material_id, m.code, m.name, m.unit_code, m.warehouse_id, w.sector_id
        FROM materials m
        JOIN warehouses w ON w.id = m.warehouse_id
        WHERE (CAST(:warehouseId AS uuid) IS NULL OR m.warehouse_id = CAST(:warehouseId AS uuid))
          AND (CAST(:materialId AS uuid) IS NULL OR m.id = CAST(:materialId AS uuid))
          AND (NOT :hasSectorFilter OR w.sector_id = ANY(CAST(:sectorIds AS uuid[])))
      )
      SELECT sm.material_id, sm.code, sm.name, sm.unit_code, sm.warehouse_id, sm.sector_id,
        COALESCE((SELECT e.balance_after FROM inventory_events e
          WHERE e.material_id = sm.material_id AND e.occurred_at < :from
          ORDER BY e.occurred_at DESC, e.sequence DESC LIMIT 1),
          (SELECT e.balance_before FROM inventory_events e
           WHERE e.material_id = sm.material_id
           ORDER BY e.occurred_at, e.sequence LIMIT 1), '0') AS opening_balance,
        COALESCE((SELECT e.balance_after FROM inventory_events e
          WHERE e.material_id = sm.material_id AND e.occurred_at < :to
          ORDER BY e.occurred_at DESC, e.sequence DESC LIMIT 1), '0') AS closing_balance,
        COALESCE(SUM(e.delta) FILTER (WHERE e.event_type = 'IN'), 0) AS operational_in,
        COALESCE(SUM(-e.delta) FILTER (WHERE e.event_type = 'OUT'), 0) AS operational_out,
        COALESCE(SUM(e.delta) FILTER (WHERE e.event_type = 'RETURN'), 0) AS returns,
        COALESCE(SUM(e.delta) FILTER (WHERE e.event_type = 'ADJUSTMENT' AND e.delta > 0), 0) AS adjustments_positive,
        COALESCE(SUM(-e.delta) FILTER (WHERE e.event_type = 'ADJUSTMENT' AND e.delta < 0), 0) AS adjustments_negative,
        COALESCE(SUM(e.delta) FILTER (WHERE e.event_type = 'OPENING'), 0) AS openings
      FROM scoped_materials sm
      LEFT JOIN inventory_events e ON e.material_id = sm.material_id
        AND e.occurred_at >= :from AND e.occurred_at < :to
        AND (CAST(:type AS text) IS NULL OR e.event_type = CAST(:type AS text))
        AND (CAST(:withdrawnBy AS uuid) IS NULL OR e.withdrawn_by = CAST(:withdrawnBy AS uuid))
        AND (CAST(:receivedBy AS uuid) IS NULL OR e.received_by = CAST(:receivedBy AS uuid))
        AND (CAST(:performedBy AS uuid) IS NULL OR e.performed_by = CAST(:performedBy AS uuid))
        AND (CAST(:authorizedBy AS uuid) IS NULL OR e.authorized_by = CAST(:authorizedBy AS uuid))
      GROUP BY sm.material_id, sm.code, sm.name, sm.unit_code, sm.warehouse_id, sm.sector_id
      ORDER BY sm.code, sm.material_id
    `, { replacements, type: 'SELECT', raw: true, transaction })
  }

  async findStatementPage({ from, to, asOf, warehouseId, sectorIds, materialId, actors = {}, type, after, limit, transaction }) {
    const replacements = {
      from, to, asOf, warehouseId: warehouseId ?? null, materialId: materialId ?? null,
      hasSectorFilter: sectorIds !== null && sectorIds !== undefined,
      sectorIds: sectorIds?.length ? `{${sectorIds.join(',')}}` : '{}', type: type ?? null,
      withdrawnBy: actors.withdrawnBy ?? null, receivedBy: actors.receivedBy ?? null,
      performedBy: actors.performedBy ?? null, authorizedBy: actors.authorizedBy ?? null,
      afterOccurredAt: after?.occurredAt ?? null, afterId: after?.id ?? null, limit,
    }
    return Database.connection.query(`
      SELECT e.id, e.material_id, e.warehouse_id, w.sector_id, e.event_type, e.delta::text AS delta,
        e.balance_before::text AS balance_before, e.balance_after::text AS balance_after,
        e.unit_code_snapshot, e.reason_code, e.description, e.sequence::text AS sequence,
        e.performed_by, e.received_by, e.withdrawn_by, e.authorized_by, e.command_origin, e.occurred_at,
        e.return_of_event_id, e.compensates_event_id
      FROM inventory_events e
      JOIN warehouses w ON w.id = e.warehouse_id
      WHERE e.occurred_at >= :from AND e.occurred_at < :to AND e.occurred_at <= :asOf
        AND (CAST(:warehouseId AS uuid) IS NULL OR e.warehouse_id = CAST(:warehouseId AS uuid))
        AND (CAST(:materialId AS uuid) IS NULL OR e.material_id = CAST(:materialId AS uuid))
        AND (NOT :hasSectorFilter OR w.sector_id = ANY(CAST(:sectorIds AS uuid[])))
        AND (CAST(:type AS text) IS NULL OR e.event_type = CAST(:type AS text))
        AND (CAST(:withdrawnBy AS uuid) IS NULL OR e.withdrawn_by = CAST(:withdrawnBy AS uuid))
        AND (CAST(:receivedBy AS uuid) IS NULL OR e.received_by = CAST(:receivedBy AS uuid))
        AND (CAST(:performedBy AS uuid) IS NULL OR e.performed_by = CAST(:performedBy AS uuid))
        AND (CAST(:authorizedBy AS uuid) IS NULL OR e.authorized_by = CAST(:authorizedBy AS uuid))
        AND (:afterOccurredAt IS NULL OR (e.occurred_at, e.id) < (CAST(:afterOccurredAt AS timestamptz), CAST(:afterId AS uuid)))
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT :limit
    `, { replacements, type: 'SELECT', raw: true, transaction })
  }
}

export default new InventoryEventRepository()