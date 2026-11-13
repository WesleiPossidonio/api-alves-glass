import InventoryOutboxRepository from '../repositories/InventoryOutboxRepository.js'

export const INVENTORY_EVENT_SCHEMA_VERSION = 1

export function createInventoryEventEnvelope(event) {
  const json = typeof event.toJSON === 'function' ? event.toJSON() : event
  const eventId = json.id
  if (!eventId || !json.material_id || !json.event_type || json.sequence === undefined) {
    throw new Error('InventoryEvent is missing fields required by the versioned Outbox envelope')
  }
  const payload = {
    schemaVersion: INVENTORY_EVENT_SCHEMA_VERSION,
    eventId,
    material: { id: json.material_id, unit: json.unit_code_snapshot },
    type: json.event_type,
    quantity: String(json.delta),
    previousBalance: String(json.balance_before),
    currentBalance: String(json.balance_after),
    responsible: {
      performedBy: json.performed_by ?? null,
      withdrawnBy: json.withdrawn_by ?? null,
      authorizedBy: json.authorized_by ?? null,
      receivedBy: json.received_by ?? null,
    },
    reason: json.reason_code ?? null,
    description: json.description,
    occurredAt: new Date(json.occurred_at).toISOString(),
    version: String(json.sequence),
    compensationOf: json.compensates_event_id ?? null,
    returnOf: json.return_of_event_id ?? null,
  }
  return {
    event_id: eventId,
    schema_version: INVENTORY_EVENT_SCHEMA_VERSION,
    aggregate_id: json.material_id,
    aggregate_version: String(json.sequence),
    event_type: 'InventoryEventRecorded',
    payload,
  }
}

class InventoryOutboxService {
  async record(event, transaction) {
    if (!transaction) throw new Error('Inventory Outbox must share the InventoryEvent transaction')
    return InventoryOutboxRepository.create(createInventoryEventEnvelope(event), transaction)
  }
}

export default new InventoryOutboxService()