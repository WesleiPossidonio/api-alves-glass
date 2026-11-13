import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import InventoryEvent from '../../src/app/models/InventoryEvent.js'
import InventoryEventRepository from '../../src/app/repositories/InventoryEventRepository.js'
import InventoryOutboxRepository from '../../src/app/repositories/InventoryOutboxRepository.js'
import InventoryOutboxService, { createInventoryEventEnvelope } from '../../src/app/services/InventoryOutboxService.js'
import Database from '../../src/database/index.js'

const root = new URL('../../', import.meta.url)
const migrationPath = new URL('../../src/database/migrations/20261118000000-create-inventory-outbox.cjs', import.meta.url)
const sampleEvent = {
  id: 'f536d07c-f171-4f15-8526-8f8717288325',
  material_id: 'd42c1559-4c73-4c3c-b3a3-22c5cad6ff42',
  event_type: 'OUT',
  delta: '-10.000',
  balance_before: '45.000',
  balance_after: '35.000',
  unit_code_snapshot: 'UN',
  performed_by: null,
  withdrawn_by: '0f2a722c-6026-482d-9d94-e32ea15f9ad1',
  authorized_by: '0f2a722c-6026-482d-9d94-e32ea15f9ad1',
  received_by: null,
  reason_code: 'QR_WITHDRAWAL',
  description: 'Retirada de estoque',
  occurred_at: new Date('2026-11-12T12:00:00.000Z'),
  sequence: '2',
  compensates_event_id: null,
  return_of_event_id: null,
}

test('Outbox Model is registered and additive migration gives event identity durable uniqueness', () => {
  assert.ok(Database.models.InventoryOutbox)
  assert.equal(Database.models.InventoryOutbox.rawAttributes.event_id.primaryKey, true)
  assert.equal(Database.models.InventoryOutbox.rawAttributes.payload.type.key, 'JSONB')
  const migration = fs.readFileSync(migrationPath, 'utf8')
  assert.match(migration, /createTable\('inventory_outbox'/)
  assert.match(migration, /event_id:[\s\S]*?primaryKey: true/)
  assert.match(migration, /references: \{ model: 'inventory_events'/)
  assert.match(migration, /aggregate_version_uq/)
})

test('versioned envelope keeps event UUID, exact decimal strings, and only available actor identity', () => {
  const envelope = createInventoryEventEnvelope(sampleEvent)
  assert.equal(envelope.event_id, sampleEvent.id)
  assert.equal(envelope.aggregate_id, sampleEvent.material_id)
  assert.equal(envelope.aggregate_version, '2')
  assert.deepEqual(envelope.payload, {
    schemaVersion: 1,
    eventId: sampleEvent.id,
    material: { id: sampleEvent.material_id, unit: 'UN' },
    type: 'OUT',
    quantity: '-10.000',
    previousBalance: '45.000',
    currentBalance: '35.000',
    responsible: {
      performedBy: null,
      withdrawnBy: sampleEvent.withdrawn_by,
      authorizedBy: sampleEvent.authorized_by,
      receivedBy: null,
    },
    reason: 'QR_WITHDRAWAL',
    description: 'Retirada de estoque',
    occurredAt: '2026-11-12T12:00:00.000Z',
    version: '2',
    compensationOf: null,
    returnOf: null,
  })
  assert.equal('operationId' in envelope.payload, false)
})

test('event and outbox writes share the exact PostgreSQL transaction; outbox failure aborts event creation', async () => {
  const originalEventCreate = InventoryEvent.create
  const originalOutboxCreate = InventoryOutboxRepository.create
  const transaction = { marker: 'same-transaction' }
  const seen = []
  try {
    InventoryEvent.create = async (_data, options) => {
      seen.push(['event', options.transaction])
      return { ...sampleEvent }
    }
    InventoryOutboxRepository.create = async (data, tx) => {
      seen.push(['outbox', tx, data.event_id])
      return data
    }
    const event = await InventoryEventRepository.create({ event_type: 'OUT' }, transaction)
    assert.equal(event.id, sampleEvent.id)
    assert.deepEqual(seen, [['event', transaction], ['outbox', transaction, sampleEvent.id]])

    InventoryOutboxRepository.create = async (_data, tx) => {
      assert.equal(tx, transaction)
      throw new Error('simulated outbox persistence failure')
    }
    await assert.rejects(InventoryEventRepository.create({ event_type: 'OPENING' }, transaction), /simulated outbox/)
  } finally {
    InventoryEvent.create = originalEventCreate
    InventoryOutboxRepository.create = originalOutboxCreate
  }
})

test('Outbox persistence rejects missing transactions and duplicate event IDs remain unique', async () => {
  const originalCreate = InventoryOutboxRepository.create
  assert.throws(() => InventoryOutboxRepository.create({ event_id: sampleEvent.id }), /requires.*transaction/)
  try {
    const inserted = new Set()
    InventoryOutboxRepository.create = async (row, transaction) => {
      assert.ok(transaction)
      if (inserted.has(row.event_id)) throw new Error('duplicate event_id')
      inserted.add(row.event_id)
      return row
    }
    const tx = { id: 1 }
    const attempts = await Promise.allSettled([
      InventoryOutboxService.record(sampleEvent, tx),
      InventoryOutboxService.record(sampleEvent, tx),
    ])
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(attempts.filter(result => result.status === 'rejected').length, 1)
    assert.equal(inserted.size, 1)
  } finally {
    InventoryOutboxRepository.create = originalCreate
  }
})