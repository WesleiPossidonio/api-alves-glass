import assert from 'node:assert/strict'
import test from 'node:test'
import { InventoryOutboxPublisher, retryDelay } from '../../src/app/services/InventoryOutboxPublisher.js'
import { InventoryProjectionConsumer, validateInventoryEnvelope } from '../../src/app/services/InventoryProjectionConsumer.js'
import { foldInventoryEvents, snapshotChecksum, snapshotInterval } from '../../src/app/services/InventorySnapshotService.js'
import { InventoryProjectionService } from '../../src/app/services/InventoryProjectionService.js'

const event = {
  schemaVersion: 1, eventId: 'f536d07c-f171-4f15-8526-8f8717288325',
  material: { id: 'd42c1559-4c73-4c3c-b3a3-22c5cad6ff42', unit: 'UN' },
  type: 'IN', quantity: '10', previousBalance: '0', currentBalance: '10',
  responsible: {}, reason: null, description: 'opening', occurredAt: '2026-11-12T12:00:00.000Z', version: '1',
}

test('Outbox publisher waits for confirms and marks publication only after confirmation', async () => {
  const calls = []
  const repository = {
    async claim() { return [{ event_id: event.eventId, payload: event, schema_version: 1, aggregate_id: event.material.id, aggregate_version: '1', event_type: 'InventoryEventRecorded', attempts: 1 }] },
    async markPublished() { calls.push('published') },
    async markFailed() { calls.push('failed') },
  }
  const channel = {
    assertExchange: async () => {}, assertQueue: async () => {}, bindQueue: async () => {}, close: async () => {},
    publish(_ex, _key, _body, options, confirm) { calls.push(['publish', options.persistent]); setTimeout(() => confirm(null), 5); return true },
  }
  const publisher = new InventoryOutboxPublisher({ repository, connections: { getRabbitConnection: async () => ({ createConfirmChannel: async () => channel }) }, logger: { warn() {}, error() {} } })
  await publisher.publishBatch()
  assert.deepEqual(calls, [['publish', true], 'published'])
  assert.equal(retryDelay(4), 8000)
})

test('Outbox publisher leaves event retryable when broker confirm fails', async () => {
  let published = false
  let failed
  const publisher = new InventoryOutboxPublisher({
    repository: {
      claim: async () => [{ event_id: event.eventId, payload: event, schema_version: 1, aggregate_id: event.material.id, aggregate_version: '1', event_type: 'InventoryEventRecorded', attempts: 1 }],
      markPublished: async () => { published = true },
      markFailed: async (_id, _worker, value) => { failed = value },
    },
    connections: { getRabbitConnection: async () => ({ createConfirmChannel: async () => ({
      assertExchange: async () => {}, assertQueue: async () => {}, bindQueue: async () => {}, close: async () => {},
      publish(_ex, _key, _body, _options, confirm) { confirm(new Error('broker down')); return false },
    }) }) },
    logger: { warn() {}, error() {} },
  })
  await publisher.publishBatch()
  assert.equal(published, false)
  assert.match(failed.error, /broker down/)
  assert.equal(failed.delayMs, 1000)
})

test('consumer validates schema v1 and commits dedupe, versioned head and movement together', async () => {
  const state = { head: null, dedupe: new Map(), movements: [] }
  const collections = {
    inventory_event_consumptions: {
      findOne: async ({ _id }) => state.dedupe.get(_id),
      insertOne: async row => { state.dedupe.set(row._id, row) },
    },
    inventory_material_heads: {
      findOne: async () => state.head,
      insertOne: async row => { state.head = row },
      replaceOne: async (_filter, row) => { state.head = row; return { modifiedCount: 1 } },
    },
    inventory_movements: { insertOne: async row => state.movements.push(row) },
  }
  const consumer = new InventoryProjectionConsumer({ connections: { getMongoDatabase: async () => ({ collection: name => collections[name] }) } })
  assert.equal((await consumer.apply(event)).duplicate, false)
  assert.equal((await consumer.apply(event)).duplicate, true)
  assert.equal(state.head.lastEventVersion, '1')
  assert.equal(state.movements.length, 1)
  await assert.rejects(consumer.apply({ ...event, eventId: 'a536d07c-f171-4f15-8526-8f8717288325', version: '3' }), /out_of_order/)
  assert.throws(() => validateInventoryEnvelope({ ...event, schemaVersion: 2 }), /invalid_inventory/)
})

test('consumer recovers canonical gaps, rejects divergent stale events, and safely serializes concurrent delivery', async () => {
  const state = { head: null, dedupe: new Map(), movements: new Map() }
  const collections = {
    inventory_event_consumptions: {
      findOne: async ({ _id }) => state.dedupe.get(_id),
      insertOne: async row => { state.dedupe.set(row._id, row) },
    },
    inventory_material_heads: {
      findOne: async () => state.head,
      insertOne: async row => { if (state.head) throw new Error('duplicate head'); state.head = row },
      replaceOne: async (_filter, row) => { state.head = row; return { modifiedCount: 1 } },
    },
    inventory_movements: {
      findOne: async filter => [...state.movements.values()].find(row => row.materialId === filter.materialId && row.version === filter.version),
      insertOne: async row => { if (state.movements.has(row._id)) throw new Error('duplicate movement'); state.movements.set(row._id, row) },
    },
  }
  const connection = { async withTransaction(callback) { await callback() }, async endSession() {} }
  const consumer = new InventoryProjectionConsumer({
    connections: {
      getMongoDatabase: async () => ({ collection: name => collections[name] }),
      getMongoClient: async () => ({ startSession: () => connection }),
    },
    loadCanonicalEvents: async (_materialId, from, through) => {
      const sequence = BigInt(from)
      if (BigInt(through) > sequence) return []
      assert.equal(BigInt(through), sequence)
      return [{ ...event, eventId: 'a536d07c-f171-4f15-8526-8f8717288325', version: sequence.toString(), previousBalance: '0', currentBalance: '5', quantity: '5' }]
    },
  })
  const future = { ...event, eventId: 'b536d07c-f171-4f15-8526-8f8717288325', version: '2', previousBalance: '5', currentBalance: '10', quantity: '5' }
  assert.deepEqual(await consumer.process(future), { duplicate: false })
  assert.equal(state.head.lastEventVersion, '2')
  assert.equal(state.movements.size, 2)
  assert.deepEqual(await consumer.process(future), { duplicate: true })
  const staleConflict = { ...event, eventId: 'c536d07c-f171-4f15-8526-8f8717288325', version: '1', currentBalance: '999' }
  await assert.rejects(consumer.process(staleConflict), /historical_conflict/)
  await assert.rejects(consumer.process({ ...future, material: { id: 'f42c1559-4c73-4c3c-b3a3-22c5cad6ff42', unit: 'UN' } }), /event_id_conflict/)
  const competing = { ...event, eventId: 'e536d07c-f171-4f15-8526-8f8717288325', version: '3', previousBalance: '10', currentBalance: '11', quantity: '1' }
  assert.deepEqual(await Promise.all([consumer.process(competing), consumer.process(competing)]), [{ duplicate: false }, { duplicate: true }])
  assert.equal(state.head.lastEventVersion, '3')
  assert.equal(state.movements.size, 3)
})

test('snapshot interval is configurable; replay validates balances and checksums', () => {
  assert.equal(snapshotInterval({ INVENTORY_SNAPSHOT_EVENT_INTERVAL: '25' }), 25)
  assert.throws(() => snapshotInterval({ INVENTORY_SNAPSHOT_EVENT_INTERVAL: '0' }), /positive integer/)
  assert.deepEqual(foldInventoryEvents([
    { sequence: '1', delta: '10.00', balance_before: '0.00', balance_after: '10.00' },
    { sequence: '2', delta: '-2.50', balance_before: '10.00', balance_after: '7.50' },
  ]), { balance: '7.50', version: '2' })
  assert.throws(() => foldInventoryEvents([{ sequence: '1', delta: '2', balance_before: '0', balance_after: '3' }]), /balance_mismatch/)
  assert.match(snapshotChecksum(event.material.id, '1', { balance: '10' }), /^[a-f0-9]{64}$/)
  assert.notEqual(snapshotChecksum(event.material.id, '1', { balance: '10' }), snapshotChecksum(event.material.id, '2', { balance: '10' }))
  assert.notEqual(snapshotChecksum(event.material.id, '1', { balance: '10' }), snapshotChecksum('a536d07c-f171-4f15-8526-8f8717288325', '1', { balance: '10' }))
})

test('projection read pagination enforces approved maximum page size', async () => {
  const service = new InventoryProjectionService({ connections: {} })
  await assert.rejects(service.getMaterialReadModel(event.material.id, { limit: 101 }), /between 1 and 100/)
})