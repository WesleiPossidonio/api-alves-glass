import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import Database from '../../../src/database/index.js'
import StockMovementService from '../../../src/app/services/StockMovementService.js'
import MovementIdempotencyRepository from '../../../src/app/repositories/MovementIdempotencyRepository.js'
import InventoryEventRepository from '../../../src/app/repositories/InventoryEventRepository.js'
import MaterialBalanceRepository from '../../../src/app/repositories/MaterialBalanceRepository.js'

const enabled = process.env.RUN_POSTGRES_STOCK_INTEGRATION === '1'

test('ledger PostgreSQL transaction, idempotency, row locking, constraints, and exact NUMERIC', { skip: !enabled }, async () => {
  assert.equal(process.env.DB_HOST, '127.0.0.1')
  assert.equal(process.env.DB_PORT, '5434')
  assert.equal(process.env.DB_DATABASE, 'alvesglass_test')
  const admin = new pg.Client({
    host: process.env.DB_HOST, port: process.env.DB_PORT,
    user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  })
  await admin.connect()
  const setup = await admin.query('SELECT current_database() database, version() version')
  assert.equal(setup.rows[0].database, 'alvesglass_test')
  assert.match(setup.rows[0].version, /PostgreSQL 17/)
  const migration = await admin.query('SELECT 1 FROM "SequelizeMeta" WHERE name=$1', ['20261113000000-create-inventory-ledger.cjs'])
  assert.equal(migration.rowCount, 1)

  const sectorId = (await admin.query("SELECT id FROM sectors WHERE code='VIDRACARIA' LIMIT 1")).rows[0]?.id
  assert.ok(sectorId)
  const ids = { user: randomUUID(), warehouse: randomUUID(), category: randomUUID(), material: randomUUID() }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16)
  const originals = {
    createEvent: InventoryEventRepository.create,
    updateBalance: MaterialBalanceRepository.updateQuantity,
    completeReceipt: MovementIdempotencyRepository.complete,
  }
  const actor = { id: ids.user, role: 'admin' }
  const command = (overrides = {}) => ({
    type: 'IN', operationId: randomUUID(), quantity: '0.125', description: 'integration receipt', ...overrides,
  })
  const counts = async () => {
    const result = await admin.query(`SELECT
      (SELECT count(*)::int FROM inventory_events WHERE material_id=$1) events,
      (SELECT count(*)::int FROM movement_idempotency WHERE warehouse_id=$2) receipts,
      (SELECT quantity::text FROM material_balances WHERE material_id=$1) balance`, [ids.material, ids.warehouse])
    return result.rows[0]
  }
  const move = (cmd, key = `int-${randomUUID()}`) => StockMovementService.move(actor, ids.material, cmd, key)

  try {
    await admin.query('BEGIN')
    await admin.query(`INSERT INTO users (id,name,email,password_hash,role,status_users,update_number,created_at,updated_at)
      VALUES ($1,$2,$3,'test-hash','admin','active','',now(),now())`, [ids.user, `ledger-${suffix}`, `ledger-${suffix}@example.test`])
    await admin.query(`INSERT INTO warehouses (id,sector_id,code,name,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'ACTIVE',now(),now())`, [ids.warehouse, sectorId, `LT-${suffix}`, `Ledger test ${suffix}`])
    await admin.query(`INSERT INTO material_categories (id,warehouse_id,name,created_at,updated_at)
      VALUES ($1,$2,$3,now(),now())`, [ids.category, ids.warehouse, `Ledger category ${suffix}`])
    await admin.query(`INSERT INTO materials (id,warehouse_id,category_id,code,name,unit_code,min_quantity,active,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'Decimal fixture','kg',0,true,now(),now())`, [ids.material, ids.warehouse, ids.category, `LEDGER-${suffix}`])
    await admin.query('INSERT INTO material_balances(material_id,quantity,updated_at) VALUES($1,$2,now())', [ids.material, '1.000'])
    await admin.query('COMMIT')
    const baseline = await counts()
    assert.equal(baseline.balance, '1.000')

    const successfulCommand = command()
    const successfulKey = `same-${suffix}`
    const success = await move(successfulCommand, successfulKey)
    assert.equal(success.balance, '1.125')
    assert.equal(success.event.balance_before, '1')
    assert.equal(success.event.balance_after, '1.125')
    const afterSuccess = await counts()
    assert.equal(afterSuccess.events, baseline.events + 1)
    assert.equal(afterSuccess.receipts, baseline.receipts + 1)
    assert.equal(afterSuccess.balance, '1.125')

    const replay = await move(successfulCommand, successfulKey)
    assert.equal(replay.event.id, success.event.id)
    assert.deepEqual(await counts(), afterSuccess)
    const differentPayload = await move({ ...successfulCommand, quantity: '0.250' }, successfulKey)
    assert.deepEqual(differentPayload, { error: 'idempotencyConflict' })
    const differentPrincipal = await StockMovementService.move({ id: randomUUID(), role: 'admin' }, ids.material, successfulCommand, successfulKey)
    assert.deepEqual(differentPrincipal, { error: 'idempotencyConflict' })
    assert.deepEqual(await counts(), afterSuccess)

    for (const [label, repository, method, replacement] of [
      ['event insert failure', InventoryEventRepository, 'create', async () => { throw new Error('injected event failure') }],
      ['balance write failure', MaterialBalanceRepository, 'updateQuantity', async () => { throw new Error('injected balance failure') }],
      ['receipt completion failure', MovementIdempotencyRepository, 'complete', async () => { throw new Error('injected receipt failure') }],
    ]) {
      const saved = repository[method]
      repository[method] = replacement
      await assert.rejects(move(command(), `failure-${label}-${suffix}`), new RegExp(`injected ${label.split(' ')[0]}`))
      repository[method] = saved
      assert.deepEqual(await counts(), afterSuccess, `${label} rolls back receipt, event, and balance`)
    }

    const invalidScale = await move(command({ quantity: '0.0001' }), `scale-${suffix}`)
    assert.deepEqual(invalidScale, { error: 'validation' })
    assert.deepEqual(await counts(), afterSuccess)

    const exactNumeric = await admin.query("SELECT '9007199254740993.123456789012345678901'::numeric::text AS v, ('0.1'::numeric+'0.2'::numeric)::text AS sum")
    assert.equal(exactNumeric.rows[0].v, '9007199254740993.123456789012345678901')
    assert.equal(exactNumeric.rows[0].sum, '0.3')

    const reject = async (sql, values, code, label) => {
      await admin.query('BEGIN')
      await admin.query('SAVEPOINT ledger_constraint')
      try { await admin.query(sql, values); assert.fail(`${label} unexpectedly accepted`) }
      catch (error) { if (error.code === 'ERR_ASSERTION') throw error; assert.equal(error.code, code, label) }
      finally { await admin.query('ROLLBACK TO SAVEPOINT ledger_constraint'); await admin.query('RELEASE SAVEPOINT ledger_constraint'); await admin.query('ROLLBACK') }
    }
    const seedEvent = success.event
    const compensationIndex = await admin.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='inventory_events_one_compensation_per_original_uq'")
    assert.equal(compensationIndex.rowCount, 1)
    assert.match(compensationIndex.rows[0].indexdef, /UNIQUE INDEX.*\(compensates_event_id\).*WHERE \(compensates_event_id IS NOT NULL\)/i)
    await reject('UPDATE inventory_events SET description=$2 WHERE id=$1', [seedEvent.id, 'tampered'], '55000', 'event update immutable')
    await reject('DELETE FROM inventory_events WHERE id=$1', [seedEvent.id], '55000', 'event delete immutable')
    await reject('DELETE FROM movement_idempotency WHERE warehouse_id=$1', [ids.warehouse], '55000', 'receipt delete immutable')
    await reject('UPDATE movement_idempotency SET response_status=200 WHERE event_id=$1', [seedEvent.id], '55000', 'completed receipt immutable')
    await reject(`INSERT INTO inventory_events
      (id,material_id,warehouse_id,event_type,delta,balance_before,balance_after,unit_code_snapshot,description,sequence,performed_by,command_origin,occurred_at)
      VALUES($1,$2,$3,'IN',1,0,2,'kg','bad equation',999,$4,'SESSION',now())`,
    [randomUUID(), ids.material, ids.warehouse, ids.user], '23514', 'event balance arithmetic check')
    await reject('UPDATE material_balances SET quantity=$2 WHERE material_id=$1', [ids.material, '-1'], '23514', 'balance nonnegative')
    await reject('UPDATE material_balances SET quantity=$2 WHERE material_id=$1', [ids.material, '1.0001'], '23514', 'unit scale trigger')
    await reject(`INSERT INTO movement_idempotency
      (id,warehouse_id,operation_id,principal_type,principal_id,idempotency_key,request_hash,created_at)
      VALUES($1,$2,$3,'USER',$4,$5,$6,now())`,
    [randomUUID(), ids.warehouse, randomUUID(), ids.user, successfulKey, '0'.repeat(64)], '23505', 'idempotency principal key uniqueness')
    await reject(`INSERT INTO movement_idempotency
      (id,warehouse_id,operation_id,principal_type,principal_id,idempotency_key,request_hash,created_at)
      VALUES($1,$2,$3,'USER',$4,$5,$6,now())`,
    [randomUUID(), ids.warehouse, successfulCommand.operationId, ids.user, `other-${suffix}`, '0'.repeat(64)], '23505', 'idempotency operation uniqueness')
    await reject(`INSERT INTO inventory_events
      (id,material_id,warehouse_id,event_type,delta,balance_before,balance_after,unit_code_snapshot,description,sequence,performed_by,command_origin,occurred_at)
      VALUES($1,$2,$3,'IN',1,0,1,'kg','bad user FK',999,$4,'SESSION',now())`,
    [randomUUID(), ids.material, ids.warehouse, randomUUID()], '23503', 'event performed_by FK')

    const concurrentCommands = [command(), command()]
    const concurrentKeys = [`concurrent-a-${suffix}`, `concurrent-b-${suffix}`]
    const beforeConcurrent = await counts()
    const concurrentResults = await Promise.all(concurrentCommands.map((cmd, index) => move(cmd, concurrentKeys[index])))
    assert.ok(concurrentResults.every(result => !result.error), JSON.stringify(concurrentResults))
    const afterConcurrent = await counts()
    assert.equal(afterConcurrent.events, beforeConcurrent.events + 2)
    assert.equal(afterConcurrent.receipts, beforeConcurrent.receipts + 2)
    assert.equal(afterConcurrent.balance, '1.375')
    assert.deepEqual(concurrentResults.map(result => [result.event.balance_before, result.event.balance_after]).sort(), [['1.125', '1.25'], ['1.25', '1.375']])

    const noNegative = await StockMovementService.move(actor, ids.material,
      command({ type: 'OUT', quantity: '999' }), `out-insufficient-${suffix}`)
    assert.deepEqual(noNegative, { error: 'insufficientBalance' })
    assert.deepEqual(await counts(), afterConcurrent)

    const unauthorized = await StockMovementService.move({ id: randomUUID(), role: 'user' }, ids.material,
      command({ type: 'OUT', quantity: '0.125' }), `out-unauthorized-${suffix}`)
    assert.deepEqual(unauthorized, { error: 'notFound' })
    assert.deepEqual(await counts(), afterConcurrent)

    const successfulOut = await move(command({ type: 'OUT', quantity: '0.125' }), `out-success-${suffix}`)
    assert.equal(successfulOut.event.delta, '-0.125')
    assert.equal(successfulOut.event.balance_before, '1.375')
    assert.equal(successfulOut.event.balance_after, '1.25')
    assert.equal(successfulOut.balance, '1.25')
    const afterOut = await counts()
    assert.equal(afterOut.balance, '1.25')
    assert.equal(afterOut.events, afterConcurrent.events + 1)
    assert.equal(afterOut.receipts, afterConcurrent.receipts + 1)

    const originalOutId = successfulOut.event.id
    const invalidReturnReference = await move(command({
      type: 'RETURN', quantity: '0.050', reasonCode: 'CUSTOMER_RETURN', originalEventId: randomUUID(),
    }), `return-invalid-reference-${suffix}`)
    assert.deepEqual(invalidReturnReference, { error: 'invalidReturnReference' })
    const unauthorizedReturn = await StockMovementService.move({ id: randomUUID(), role: 'user' }, ids.material,
      command({ type: 'RETURN', quantity: '0.050', reasonCode: 'CUSTOMER_RETURN', originalEventId: originalOutId }), `return-unauthorized-${suffix}`)
    assert.deepEqual(unauthorizedReturn, { error: 'notFound' })
    assert.deepEqual(await counts(), afterOut)

    const partialReturnCommand = command({ type: 'RETURN', quantity: '0.050', reasonCode: 'CUSTOMER_RETURN', originalEventId: originalOutId })
    const partialReturnKey = `return-part-${suffix}`
    const returnedPart = await move(partialReturnCommand, partialReturnKey)
    assert.equal(returnedPart.event.event_type, 'RETURN')
    assert.equal(returnedPart.event.delta, '0.05')
    assert.equal(returnedPart.event.return_of_event_id, originalOutId)
    assert.equal(returnedPart.event.balance_before, '1.25')
    assert.equal(returnedPart.event.balance_after, '1.3')
    const afterPartialReturn = await counts()
    assert.equal(afterPartialReturn.balance, '1.3')
    assert.equal(afterPartialReturn.events, afterOut.events + 1)
    const replayReturn = await move(partialReturnCommand, partialReturnKey)
    assert.equal(replayReturn.event.id, returnedPart.event.id)
    assert.deepEqual(await counts(), afterPartialReturn)

    const returnedRest = await move(command({ type: 'RETURN', quantity: '0.075', reasonCode: 'CUSTOMER_RETURN', originalEventId: originalOutId }), `return-rest-${suffix}`)
    assert.equal(returnedRest.event.return_of_event_id, originalOutId)
    assert.equal(returnedRest.balance, '1.375')
    const afterFullReturn = await counts()
    assert.equal(afterFullReturn.events, afterPartialReturn.events + 1)
    const originalStillOut = await admin.query('SELECT event_type,delta::text,balance_after::text FROM inventory_events WHERE id=$1', [originalOutId])
    assert.deepEqual(originalStillOut.rows[0], { event_type: 'OUT', delta: '-0.125', balance_after: '1.25' })
    const excessiveReturn = await move(command({ type: 'RETURN', quantity: '0.001', reasonCode: 'CUSTOMER_RETURN', originalEventId: originalOutId }), `return-excess-${suffix}`)
    assert.deepEqual(excessiveReturn, { error: 'returnExceedsOriginal' })
    assert.deepEqual(await counts(), afterFullReturn)

    const adminOnly = await StockMovementService.move({ id: randomUUID(), role: 'user' }, ids.material,
      command({ type: 'ADJUSTMENT', delta: '0.025', reasonCode: 'COUNT', description: 'count correction' }), `adjust-user-${suffix}`)
    assert.deepEqual(adminOnly, { error: 'forbidden' })
    const missingReason = await move(command({ type: 'ADJUSTMENT', delta: '0.025', reasonCode: '' }), `adjust-no-reason-${suffix}`)
    assert.deepEqual(missingReason, { error: 'validation' })
    const negativeAdjustment = await move(command({ type: 'ADJUSTMENT', delta: '-0.025', reasonCode: 'COUNT_CORRECTION', description: 'physical count correction' }), `adjust-negative-${suffix}`)
    assert.equal(negativeAdjustment.event.event_type, 'ADJUSTMENT')
    assert.equal(negativeAdjustment.event.delta, '-0.025')
    assert.equal(negativeAdjustment.balance, '1.35')
    const positiveAdjustmentCommand = command({ type: 'ADJUSTMENT', delta: '0.125', reasonCode: 'COUNT_CORRECTION', description: 'physical count correction' })
    const positiveAdjustmentKey = `adjust-positive-${suffix}`
    const positiveAdjustment = await move(positiveAdjustmentCommand, positiveAdjustmentKey)
    assert.equal(positiveAdjustment.event.delta, '0.125')
    assert.equal(positiveAdjustment.balance, '1.475')
    const afterPositiveAdjustment = await counts()
    const replayAdjustment = await move(positiveAdjustmentCommand, positiveAdjustmentKey)
    assert.equal(replayAdjustment.event.id, positiveAdjustment.event.id)
    const afterAdjustments = await counts()
    assert.deepEqual(afterAdjustments, afterPositiveAdjustment, 'adjustment replay does not duplicate event or receipt')
    const adjustmentBelowZero = await move(command({ type: 'ADJUSTMENT', delta: '-2', reasonCode: 'COUNT_CORRECTION' }), `adjust-below-zero-${suffix}`)
    assert.deepEqual(adjustmentBelowZero, { error: 'insufficientBalance' })
    assert.deepEqual(await counts(), afterPositiveAdjustment)

    const compensationTarget = positiveAdjustment.event
    const compensationCommand = { type: 'COMPENSATION', operationId: randomUUID(), originalEventId: compensationTarget.id, reasonCode: 'ENTRY_ERROR', description: 'reverse incorrect adjustment' }
    const compensationKey = `compensate-${suffix}`
    const compensation = await move(compensationCommand, compensationKey)
    assert.equal(compensation.event.event_type, 'ADJUSTMENT')
    assert.equal(compensation.event.delta, '-0.125')
    assert.equal(compensation.event.compensates_event_id, compensationTarget.id)
    assert.equal(compensation.balance, '1.35')
    const compensationReplay = await move(compensationCommand, compensationKey)
    assert.equal(compensationReplay.event.id, compensation.event.id)
    assert.deepEqual(await move({ ...compensationCommand, operationId: randomUUID() }, `compensate-again-${suffix}`), { error: 'alreadyCompensated' })

    const openingEventId = (await admin.query("SELECT id FROM inventory_events WHERE material_id=$1 AND event_type='OPENING'", [ids.material])).rows[0]?.id
    if (openingEventId) assert.deepEqual(await move({ ...compensationCommand, originalEventId: openingEventId, operationId: randomUUID() }, `compensate-opening-${suffix}`), { error: 'invalidCompensationReference' })

    const concurrentTarget = success.event
    const concurrentCompensationCommand = { ...compensationCommand, originalEventId: concurrentTarget.id }
    const compensationRace = await Promise.all([
      move({ ...concurrentCompensationCommand, operationId: randomUUID() }, `comp-race-a-${suffix}`),
      move({ ...concurrentCompensationCommand, operationId: randomUUID() }, `comp-race-b-${suffix}`),
    ])
    const committedCompensations = compensationRace.filter(result => result.event?.compensates_event_id === concurrentTarget.id)
    assert.equal(committedCompensations.length, 1, JSON.stringify(compensationRace))
    assert.equal(compensationRace.filter(result => result.error === 'alreadyCompensated').length, 1, JSON.stringify(compensationRace))
    const compensationRows = await admin.query('SELECT count(*)::int n FROM inventory_events WHERE compensates_event_id=$1', [concurrentTarget.id])
    assert.equal(compensationRows.rows[0].n, 1, 'partial unique index guarantees one concurrent compensation')
    const afterCompensationRace = await counts()


    const invalidNegative = await move(command({ type: 'OUT', quantity: '-0.125' }), `out-negative-${suffix}`)
    assert.deepEqual(invalidNegative, { error: 'validation' })
    const invalidScaleOut = await move(command({ type: 'OUT', quantity: '0.0001' }), `out-scale-${suffix}`)
    assert.deepEqual(invalidScaleOut, { error: 'validation' })
    assert.deepEqual(await counts(), afterCompensationRace)
  } finally {
    InventoryEventRepository.create = originals.createEvent
    MaterialBalanceRepository.updateQuantity = originals.updateBalance
    MovementIdempotencyRepository.complete = originals.completeReceipt
    // Successful ledger rows are intentionally retained: database triggers enforce append-only
    // events and immutable receipts; all fixture identifiers are random and test-prefixed.
    await admin.end()
    await Database.connection.close()
  }
})