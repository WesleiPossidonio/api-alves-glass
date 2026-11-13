import assert from 'node:assert/strict'
import test from 'node:test'
import InventoryEvent from '../../src/app/models/InventoryEvent.js'
import MovementIdempotency from '../../src/app/models/MovementIdempotency.js'
import Database from '../../src/database/index.js'

test('ledger Models are registered once with exact numeric event fields and no receipt expiry assumption', () => {
  assert.ok(Database.models.InventoryEvent)
  assert.ok(Database.models.MovementIdempotency)
  assert.equal(InventoryEvent.rawAttributes.delta.type.key, 'DECIMAL')
  assert.equal(InventoryEvent.rawAttributes.balance_before.type.key, 'DECIMAL')
  assert.equal(InventoryEvent.rawAttributes.balance_after.type.key, 'DECIMAL')
  assert.equal(MovementIdempotency.rawAttributes.request_hash.type.key, 'STRING')
  assert.equal(MovementIdempotency.rawAttributes.expires_at, undefined)
  assert.equal(typeof Database.models.InventoryEvent.update, 'function')
})