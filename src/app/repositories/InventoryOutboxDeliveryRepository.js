import Database from '../../database/index.js'

class InventoryOutboxDeliveryRepository {
  async claim({ workerId, limit = 20, leaseMs = 30000 } = {}) {
    return Database.connection.transaction(async transaction => {
      const rows = await Database.connection.query(`
        SELECT event_id, schema_version, aggregate_id, aggregate_version, event_type, payload, attempts, status, last_error
        FROM inventory_outbox
        WHERE ((status IN ('PENDING','RETRY') AND available_at <= CURRENT_TIMESTAMP)
           OR (status = 'PROCESSING' AND locked_until <= CURRENT_TIMESTAMP)
           OR (status = 'DEAD' AND available_at <= CURRENT_TIMESTAMP))
        ORDER BY created_at, event_id
        LIMIT :limit
        FOR UPDATE SKIP LOCKED
      `, { replacements: { limit }, type: 'SELECT', transaction })
      if (!rows.length) return []
      const ids = rows.map(row => row.event_id)
      await Database.connection.query(`
        UPDATE inventory_outbox SET
        status = 'PROCESSING',
        locked_by = CAST(:workerId AS UUID),
        locked_until = CURRENT_TIMESTAMP + (:leaseMs * INTERVAL '1 millisecond'),
        attempts = CASE WHEN inventory_outbox.status = 'DEAD' THEN inventory_outbox.attempts ELSE inventory_outbox.attempts + 1 END,
        available_at = CURRENT_TIMESTAMP
        WHERE event_id IN (:ids)
      `, { replacements: { workerId, leaseMs, ids }, transaction })
      return rows.map(row => ({ ...row, attempts: Number(row.attempts) + (row.status === 'DEAD' ? 0 : 1), status: 'PROCESSING' }))
    })
  }

  async markPublished(eventId, workerId) {
    const [rows] = await Database.connection.query(`
      UPDATE inventory_outbox SET status = 'PUBLISHED', locked_by = NULL, locked_until = NULL, last_error = NULL
      WHERE event_id = :eventId AND status = 'PROCESSING' AND locked_by = :workerId
      RETURNING event_id
    `, { replacements: { eventId, workerId } })
    return rows?.length === 1
  }

  async markFailed(eventId, workerId, { error, delayMs, maxAttempts }) {
    await Database.connection.query(`
      UPDATE inventory_outbox SET status = CASE WHEN attempts >= :maxAttempts THEN 'DEAD' ELSE 'RETRY' END,
        available_at = CASE WHEN attempts >= :maxAttempts THEN available_at ELSE CURRENT_TIMESTAMP + (:delayMs * INTERVAL '1 millisecond') END,
        locked_by = NULL, locked_until = NULL, last_error = :error
      WHERE event_id = :eventId AND status = 'PROCESSING' AND locked_by = :workerId
    `, { replacements: { eventId, workerId, delayMs, maxAttempts, error: String(error).slice(0, 4000) } })
  }

  async markDeadPublished(eventIds, workerId) {
    const ids = Array.isArray(eventIds) ? eventIds : [eventIds]
    if (ids.length === 0) return 0
    const [rows] = await Database.connection.query(`
      UPDATE inventory_outbox SET locked_by = NULL, locked_until = NULL,
        available_at = CURRENT_TIMESTAMP + INTERVAL '100 years'
      WHERE event_id IN (:eventIds) AND status = 'DEAD' AND locked_by = CAST(:workerId AS UUID)
      RETURNING event_id
    `, { replacements: { eventIds: ids, workerId } })
    return rows?.length ?? 0
  }
}

export default new InventoryOutboxDeliveryRepository()