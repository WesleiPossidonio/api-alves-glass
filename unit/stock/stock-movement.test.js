import assert from 'node:assert/strict'
import test from 'node:test'
import Database from '../../src/database/index.js'
import StockMovementService from '../../src/app/services/StockMovementService.js'
import MaterialRepository from '../../src/app/repositories/MaterialRepository.js'
import MaterialBalanceRepository from '../../src/app/repositories/MaterialBalanceRepository.js'
import InventoryEventRepository from '../../src/app/repositories/InventoryEventRepository.js'
import MovementIdempotencyRepository from '../../src/app/repositories/MovementIdempotencyRepository.js'
import UserSectorRepository from '../../src/app/repositories/UserSectorRepository.js'

test('IN and OUT use signed deltas, positive quantities, exact scale, and transaction-scoped repositories', async () => {
  const originals = {
    transaction: Database.connection.transaction,
    material: MaterialRepository.findById,
    balance: MaterialBalanceRepository.findByMaterialIdForUpdate,
    updateBalance: MaterialBalanceRepository.updateQuantity,
    latest: InventoryEventRepository.findLatestForMaterial,
    original: InventoryEventRepository.findByIdForUpdate,
    returns: InventoryEventRepository.findReturnsForUpdate,
    compensations: InventoryEventRepository.findCompensations,
    createEvent: InventoryEventRepository.create,
    principalReceipt: MovementIdempotencyRepository.findByPrincipalKey,
    operationReceipt: MovementIdempotencyRepository.findByOperationId,
    createReceipt: MovementIdempotencyRepository.create,
    completeReceipt: MovementIdempotencyRepository.complete,
  }
  const transaction = { LOCK: { UPDATE: 'UPDATE' } }
  const calls = []
  let balance = '1.000'
  let event
  const receipt = { id: 'receipt-1' }
  try {
    Database.connection.transaction = async callback => callback(transaction)
    MaterialRepository.findById = async (id, options) => {
      calls.push(['material', options.transaction])
      return { id, active: true, warehouse_id: 'w1', unit_code: 'kg' }
    }
    MaterialBalanceRepository.findByMaterialIdForUpdate = async (id, tx) => {
      calls.push(['lock', tx])
      return { quantity: balance }
    }
    InventoryEventRepository.findLatestForMaterial = async (id, tx) => { calls.push(['latest', tx]); return null }
    InventoryEventRepository.findByIdForUpdate = async (id, tx) => { calls.push(['original', tx]); return { id, event_type: 'OUT', material_id: 'm1', delta: '-0.250' } }
    InventoryEventRepository.findReturnsForUpdate = async (id, tx) => { calls.push(['returns', tx]); return [] }
    InventoryEventRepository.findCompensations = async (id, tx) => { calls.push(['compensations', tx]); return [] }
    MovementIdempotencyRepository.findByPrincipalKey = async (key, tx) => { calls.push(['read-receipt', tx]); return null }
    MovementIdempotencyRepository.findByOperationId = async (warehouseId, operationId, tx) => { calls.push(['operation', tx]); return null }
    MovementIdempotencyRepository.create = async (data, tx) => { calls.push(['create-receipt', tx]); return receipt }
    InventoryEventRepository.create = async (data, tx) => { calls.push(['create-event', tx]); return { id: 'event-1', ...data } }
    MaterialBalanceRepository.updateQuantity = async (id, quantity, tx) => { calls.push(['update-balance', tx]); balance = quantity; return [1] }
    MovementIdempotencyRepository.complete = async (id, data, tx) => { calls.push(['complete', tx]); return [1] }

    const actor = { id: 'admin-1', role: 'admin' }
    const command = type => ({ type, operationId: '98b4d1bd-75e1-4b4f-9ea8-c663d41b6b53', quantity: '0.125', description: ' justified ' })
    const inbound = await StockMovementService.move(actor, 'm1', command('IN'), 'key-in')
    assert.equal(inbound.event.delta, '0.125')
    assert.equal(inbound.balance, '1.125')
    assert.equal(inbound.event.description, 'justified')
    const outbound = await StockMovementService.move(actor, 'm1', command('OUT'), 'key-out')
    assert.equal(outbound.event.delta, '-0.125')
    assert.equal(outbound.event.balance_before, '1.125')
    assert.equal(outbound.event.balance_after, '1')
    assert.equal(outbound.balance, '1')
    const returned = await StockMovementService.move(actor, 'm1', {
      ...command('RETURN'), operationId: '2b983254-b082-45d6-b209-85b49cf84e10', reasonCode: 'CUSTOMER_RETURN', originalEventId: 'original-out',
    }, 'key-return')
    assert.equal(returned.event.event_type, 'RETURN')
    assert.equal(returned.event.delta, '0.125')
    assert.equal(returned.event.return_of_event_id, 'original-out')
    assert.equal(returned.balance, '1.125')
    const adjustment = await StockMovementService.move(actor, 'm1', {
      type: 'ADJUSTMENT', operationId: '9235f894-597a-4421-a85d-fc67e09cc334',
      delta: '-0.025', reasonCode: 'COUNT_CORRECTION', description: 'count correction',
    }, 'key-adjustment')
    assert.equal(adjustment.event.event_type, 'ADJUSTMENT')
    assert.equal(adjustment.event.delta, '-0.025')
    assert.equal(adjustment.event.reason_code, 'COUNT_CORRECTION')
    assert.equal(adjustment.balance, '1.1')
    assert.ok(calls.every(([, tx]) => tx === transaction))
  } finally {
    Database.connection.transaction = originals.transaction
    MaterialRepository.findById = originals.material
    MaterialBalanceRepository.findByMaterialIdForUpdate = originals.balance
    MaterialBalanceRepository.updateQuantity = originals.updateBalance
    InventoryEventRepository.findLatestForMaterial = originals.latest
    InventoryEventRepository.findByIdForUpdate = originals.original
    InventoryEventRepository.findReturnsForUpdate = originals.returns
    InventoryEventRepository.findCompensations = originals.compensations
    InventoryEventRepository.create = originals.createEvent
    MovementIdempotencyRepository.findByPrincipalKey = originals.principalReceipt
    MovementIdempotencyRepository.findByOperationId = originals.operationReceipt
    MovementIdempotencyRepository.create = originals.createReceipt
    MovementIdempotencyRepository.complete = originals.completeReceipt
  }
})

test('ADJUSTMENT is admin-only, signed, and requires a reason', async () => {
  const originals = {
    transaction: Database.connection.transaction,
    material: MaterialRepository.findById,
    balance: MaterialBalanceRepository.findByMaterialIdForUpdate,
    receiptLookup: MovementIdempotencyRepository.findByPrincipalKey,
    operationLookup: MovementIdempotencyRepository.findByOperationId,
    createReceipt: MovementIdempotencyRepository.create,
    updateBalance: MaterialBalanceRepository.updateQuantity,
    latest: InventoryEventRepository.findLatestForMaterial,
    createEvent: InventoryEventRepository.create,
    complete: MovementIdempotencyRepository.complete,
  }
  let balanceReads = 0
  try {
    Database.connection.transaction = async callback => callback({ LOCK: { UPDATE: 'UPDATE' } })
    MaterialRepository.findById = async id => ({ id, active: true, warehouse_id: 'w1', unit_code: 'kg' })
    MaterialBalanceRepository.findByMaterialIdForUpdate = async () => { balanceReads += 1; return { quantity: '1' } }
    MovementIdempotencyRepository.findByPrincipalKey = async () => null
    MovementIdempotencyRepository.findByOperationId = async () => null
    MovementIdempotencyRepository.create = async () => ({ id: 'test-receipt' })
    MaterialBalanceRepository.updateQuantity = async () => [1]
    InventoryEventRepository.findLatestForMaterial = async () => null
    InventoryEventRepository.create = async data => ({ id: 'test-event', ...data })
    MovementIdempotencyRepository.complete = async () => [1]
    const command = { type: 'ADJUSTMENT', operationId: '9235f894-597a-4421-a85d-fc67e09cc334', delta: '0.1', reasonCode: 'COUNT', description: 'count' }
    assert.deepEqual(await StockMovementService.move({ id: 'user-1', role: 'user' }, 'm1', command, 'user-adjust'), { error: 'forbidden' })
    assert.deepEqual(await StockMovementService.move({ id: 'admin-1', role: 'admin' }, 'm1', { ...command, reasonCode: '' }, 'missing-reason'), { error: 'validation' })
    assert.deepEqual(await StockMovementService.move({ id: 'admin-1', role: 'admin' }, 'm1', { ...command, delta: '-1.001' }, 'below-zero'), { error: 'insufficientBalance' })
    assert.equal(balanceReads, 1)
  } finally {
    Database.connection.transaction = originals.transaction
    MaterialRepository.findById = originals.material
    MaterialBalanceRepository.findByMaterialIdForUpdate = originals.balance
    MovementIdempotencyRepository.findByPrincipalKey = originals.receiptLookup
    MovementIdempotencyRepository.findByOperationId = originals.operationLookup
    MovementIdempotencyRepository.create = originals.createReceipt
    MaterialBalanceRepository.updateQuantity = originals.updateBalance
    InventoryEventRepository.findLatestForMaterial = originals.latest
    InventoryEventRepository.create = originals.createEvent
    MovementIdempotencyRepository.complete = originals.complete
  }
})

test('OUT rejects negative, zero, over-scale and insufficient quantities without committing a receipt', async () => {
  const originals = {
    transaction: Database.connection.transaction,
    material: MaterialRepository.findById,
    balance: MaterialBalanceRepository.findByMaterialIdForUpdate,
    principalReceipt: MovementIdempotencyRepository.findByPrincipalKey,
    operationReceipt: MovementIdempotencyRepository.findByOperationId,
    createReceipt: MovementIdempotencyRepository.create,
  }
  let receiptWrites = 0
  try {
    Database.connection.transaction = async callback => callback({ LOCK: { UPDATE: 'UPDATE' } })
    MaterialRepository.findById = async id => ({ id, active: true, warehouse_id: 'w1', unit_code: 'un' })
    MaterialBalanceRepository.findByMaterialIdForUpdate = async () => ({ quantity: '1' })
    MovementIdempotencyRepository.findByPrincipalKey = async () => null
    MovementIdempotencyRepository.findByOperationId = async () => null
    MovementIdempotencyRepository.create = async () => { receiptWrites += 1; return { id: 'r1' } }
    const actor = { id: 'admin-1', role: 'admin' }
    const base = { type: 'OUT', operationId: '98b4d1bd-75e1-4b4f-9ea8-c663d41b6b53', description: 'reason' }
    for (const quantity of ['-1', '0', '1.1']) {
      assert.deepEqual(await StockMovementService.move(actor, 'm1', { ...base, quantity }, `k-${quantity}`), { error: 'validation' })
    }
    assert.equal(receiptWrites, 0)
    assert.deepEqual(await StockMovementService.move(actor, 'm1', { ...base, quantity: '2' }, 'too-much'), { error: 'insufficientBalance' })
    assert.equal(receiptWrites, 1, 'receipt write is attempted inside transaction then rolled back by insufficient-balance abort')
  } finally {
    Database.connection.transaction = originals.transaction
    MaterialRepository.findById = originals.material
    MaterialBalanceRepository.findByMaterialIdForUpdate = originals.balance
    MovementIdempotencyRepository.findByPrincipalKey = originals.principalReceipt
    MovementIdempotencyRepository.findByOperationId = originals.operationReceipt
    MovementIdempotencyRepository.create = originals.createReceipt
  }
})

test('RETURN requires a valid OUT reference when supplied and enforces remaining returnable quantity', async () => {
  const originals = {
    transaction: Database.connection.transaction,
    material: MaterialRepository.findById,
    balance: MaterialBalanceRepository.findByMaterialIdForUpdate,
    original: InventoryEventRepository.findByIdForUpdate,
    returns: InventoryEventRepository.findReturnsForUpdate,
    receipt: MovementIdempotencyRepository.findByPrincipalKey,
    operation: MovementIdempotencyRepository.findByOperationId,
    createReceipt: MovementIdempotencyRepository.create,
    createEvent: InventoryEventRepository.create,
  }
  let includedReturns = [{ delta: '0.125' }]
  let originalEvent = { id: 'out-1', event_type: 'OUT', material_id: 'm1', delta: '-0.250' }
  try {
    Database.connection.transaction = async callback => callback({ LOCK: { UPDATE: 'UPDATE' } })
    MaterialRepository.findById = async id => ({ id, active: true, warehouse_id: 'w1', unit_code: 'kg' })
    MaterialBalanceRepository.findByMaterialIdForUpdate = async () => ({ quantity: '1.000' })
    InventoryEventRepository.findByIdForUpdate = async () => originalEvent
    InventoryEventRepository.findReturnsForUpdate = async () => includedReturns
    MovementIdempotencyRepository.findByPrincipalKey = async () => null
    MovementIdempotencyRepository.findByOperationId = async () => null
    MovementIdempotencyRepository.create = async () => ({ id: 'r1' })
    InventoryEventRepository.create = async data => ({ id: 'e1', ...data })
    const actor = { id: 'admin-1', role: 'admin' }
    const base = { type: 'RETURN', operationId: '98b4d1bd-75e1-4b4f-9ea8-c663d41b6b53', description: 'return', reasonCode: 'CUSTOMER_RETURN', originalEventId: 'out-1' }
    assert.deepEqual(await StockMovementService.move(actor, 'm1', { ...base, quantity: '0.126' }, 'return-too-much'), { error: 'returnExceedsOriginal' })
    assert.deepEqual(await StockMovementService.move(actor, 'm1', { ...base, quantity: '-0.125' }, 'return-negative'), { error: 'validation' })
    originalEvent = { ...originalEvent, event_type: 'IN' }
    assert.deepEqual(await StockMovementService.move(actor, 'm1', { ...base, quantity: '0.125' }, 'return-wrong-type'), { error: 'invalidReturnReference' })
    originalEvent = { ...originalEvent, event_type: 'OUT', material_id: 'another-material' }
    assert.deepEqual(await StockMovementService.move(actor, 'm1', { ...base, quantity: '0.125' }, 'return-wrong-material'), { error: 'invalidReturnReference' })
  } finally {
    Database.connection.transaction = originals.transaction
    MaterialRepository.findById = originals.material
    MaterialBalanceRepository.findByMaterialIdForUpdate = originals.balance
    InventoryEventRepository.findByIdForUpdate = originals.original
    InventoryEventRepository.findReturnsForUpdate = originals.returns
    MovementIdempotencyRepository.findByPrincipalKey = originals.receipt
    MovementIdempotencyRepository.findByOperationId = originals.operation
    MovementIdempotencyRepository.create = originals.createReceipt
    InventoryEventRepository.create = originals.createEvent
  }
})

test('admin compensation creates an inverse ADJUSTMENT once and replays through the existing receipt', async () => {
  const originals = {
    transaction: Database.connection.transaction,
    material: MaterialRepository.findById,
    balance: MaterialBalanceRepository.findByMaterialIdForUpdate,
    updateBalance: MaterialBalanceRepository.updateQuantity,
    original: InventoryEventRepository.findByIdForUpdate,
    compensations: InventoryEventRepository.findCompensations,
    latest: InventoryEventRepository.findLatestForMaterial,
    createEvent: InventoryEventRepository.create,
    findPrincipal: MovementIdempotencyRepository.findByPrincipalKey,
    findOperation: MovementIdempotencyRepository.findByOperationId,
    createReceipt: MovementIdempotencyRepository.create,
    completeReceipt: MovementIdempotencyRepository.complete,
  }
  const tx = { LOCK: { UPDATE: 'UPDATE' } }
  const original = { id: 'event-in', material_id: 'm1', event_type: 'IN', delta: '0.250', compensates_event_id: null }
  const stored = []
  const receipts = new Map()
  let balance = '0.250'
  try {
    Database.connection.transaction = async callback => callback(tx)
    MaterialRepository.findById = async id => ({ id, active: true, warehouse_id: 'w1', unit_code: 'kg' })
    InventoryEventRepository.findByIdForUpdate = async id => id === original.id ? original : null
    InventoryEventRepository.findCompensations = async id => stored.filter(event => event.compensates_event_id === id)
    MaterialBalanceRepository.findByMaterialIdForUpdate = async () => ({ quantity: balance })
    MaterialBalanceRepository.updateQuantity = async (_id, quantity) => { balance = quantity }
    InventoryEventRepository.findLatestForMaterial = async () => stored.at(-1) ?? null
    InventoryEventRepository.create = async data => { const event = { id: 'event-comp', ...data }; stored.push(event); return event }
    MovementIdempotencyRepository.findByPrincipalKey = async ({ idempotencyKey }) => receipts.get(idempotencyKey) ?? null
    MovementIdempotencyRepository.findByOperationId = async () => null
    MovementIdempotencyRepository.create = async data => ({ id: 'receipt-comp', ...data })
    MovementIdempotencyRepository.complete = async (_id, result) => { receipts.set('comp-key', { request_hash: 'same', operation_id: command.operationId, response_body: result }); return [1] }
    const actor = { id: 'admin-1', role: 'admin' }
    const command = { type: 'COMPENSATION', operationId: '98b4d1bd-75e1-4b4f-9ea8-c663d41b6b53', originalEventId: original.id, reasonCode: 'ENTRY_ERROR', description: 'reverse incorrect entry' }
    const result = await StockMovementService.move(actor, 'm1', command, 'comp-key')
    assert.equal(result.event.event_type, 'ADJUSTMENT')
    assert.equal(result.event.delta, '-0.25')
    assert.equal(result.event.compensates_event_id, original.id)
    assert.equal(result.event.performed_by, actor.id)
    assert.equal(result.event.reason_code, command.reasonCode)
    assert.equal(result.balance, '0')
    assert.equal(original.delta, '0.250')
  } finally {
    Database.connection.transaction = originals.transaction
    MaterialRepository.findById = originals.material
    MaterialBalanceRepository.findByMaterialIdForUpdate = originals.balance
    MaterialBalanceRepository.updateQuantity = originals.updateBalance
    InventoryEventRepository.findByIdForUpdate = originals.original
    InventoryEventRepository.findCompensations = originals.compensations
    InventoryEventRepository.findLatestForMaterial = originals.latest
    InventoryEventRepository.create = originals.createEvent
    MovementIdempotencyRepository.findByPrincipalKey = originals.findPrincipal
    MovementIdempotencyRepository.findByOperationId = originals.findOperation
    MovementIdempotencyRepository.create = originals.createReceipt
    MovementIdempotencyRepository.complete = originals.completeReceipt
  }
})

test('compensation rejects non-admin, missing reason/reference, OPENING, compensation, duplicate, and negative balance', async () => {
  const originals = {
    transaction: Database.connection.transaction,
    material: MaterialRepository.findById,
    original: InventoryEventRepository.findByIdForUpdate,
    compensations: InventoryEventRepository.findCompensations,
    principal: MovementIdempotencyRepository.findByPrincipalKey,
    operation: MovementIdempotencyRepository.findByOperationId,
    receipt: MovementIdempotencyRepository.create,
    balance: MaterialBalanceRepository.findByMaterialIdForUpdate,
    latest: InventoryEventRepository.findLatestForMaterial,
  }
  let original = { id: 'evt', material_id: 'm1', event_type: 'OPENING', delta: '1.000', compensates_event_id: null }
  let linked = []
  try {
    Database.connection.transaction = async callback => callback({ LOCK: { UPDATE: 'UPDATE' } })
    MaterialRepository.findById = async id => ({ id, active: true, warehouse_id: 'w1', unit_code: 'kg' })
    InventoryEventRepository.findByIdForUpdate = async () => original
    InventoryEventRepository.findCompensations = async () => linked
    MovementIdempotencyRepository.findByPrincipalKey = async () => null
    MovementIdempotencyRepository.findByOperationId = async () => null
    MovementIdempotencyRepository.create = async () => ({ id: 'r' })
    MaterialBalanceRepository.findByMaterialIdForUpdate = async () => ({ quantity: '0.500' })
    InventoryEventRepository.findLatestForMaterial = async () => null
    const command = { type: 'COMPENSATION', operationId: '98b4d1bd-75e1-4b4f-9ea8-c663d41b6b53', originalEventId: 'evt', reasonCode: 'FIX', description: 'reverse' }
    assert.deepEqual(await StockMovementService.move({ id: 'user', role: 'user' }, 'm1', command, 'non-admin'), { error: 'forbidden' })
    assert.deepEqual(await StockMovementService.move({ id: 'admin', role: 'admin' }, 'm1', { ...command, reasonCode: '' }, 'no-reason'), { error: 'validation' })
    assert.deepEqual(await StockMovementService.move({ id: 'admin', role: 'admin' }, 'm1', { ...command, originalEventId: '' }, 'no-original'), { error: 'validation' })
    assert.deepEqual(await StockMovementService.move({ id: 'admin', role: 'admin' }, 'm1', command, 'opening'), { error: 'invalidCompensationReference' })
    original = { ...original, event_type: 'ADJUSTMENT', delta: '-1.000', compensates_event_id: 'prior' }
    assert.deepEqual(await StockMovementService.move({ id: 'admin', role: 'admin' }, 'm1', { ...command, originalEventId: 'child' }, 'child'), { error: 'invalidCompensationReference' })
    original = { id: 'evt', material_id: 'm1', event_type: 'IN', delta: '1.000', compensates_event_id: null }
    linked = [{ id: 'already-linked' }]
    assert.deepEqual(await StockMovementService.move({ id: 'admin', role: 'admin' }, 'm1', command, 'duplicate'), { error: 'alreadyCompensated' })
    linked = []
    assert.deepEqual(await StockMovementService.move({ id: 'admin', role: 'admin' }, 'm1', command, 'negative'), { error: 'insufficientBalance' })
  } finally {
    Database.connection.transaction = originals.transaction
    MaterialRepository.findById = originals.material
    InventoryEventRepository.findByIdForUpdate = originals.original
    InventoryEventRepository.findCompensations = originals.compensations
    MovementIdempotencyRepository.findByPrincipalKey = originals.principal
    MovementIdempotencyRepository.findByOperationId = originals.operation
    MovementIdempotencyRepository.create = originals.receipt
    MaterialBalanceRepository.findByMaterialIdForUpdate = originals.balance
    InventoryEventRepository.findLatestForMaterial = originals.latest
  }
})

test('compensation unique migration is partial, targets the existing self-reference, and matches event schema', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const ledger = fs.readFileSync(path.join(root, 'src/database/migrations/20261113000000-create-inventory-ledger.cjs'), 'utf8')
  const compensation = fs.readFileSync(path.join(root, 'src/database/migrations/20261114000000-unique-inventory-event-compensation.cjs'), 'utf8')
  assert.match(ledger, /compensates_event_id: \{ type: Sequelize\.UUID, allowNull: true, references: \{ model: 'inventory_events', key: 'id' \}/)
  assert.match(compensation, /addIndex\('inventory_events', \['compensates_event_id'\]/)
  assert.match(compensation, /name: 'inventory_events_one_compensation_per_original_uq'/)
  assert.match(compensation, /unique: true/)
  assert.match(compensation, /where: \{ compensates_event_id: \{ \[Sequelize\.Op\.ne\]: null \} \}/)
})
