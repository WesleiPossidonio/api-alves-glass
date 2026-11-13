import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import Database from '../../../src/database/index.js'
import MaterialRepository from '../../../src/app/repositories/MaterialRepository.js'
import InventoryEventRepository from '../../../src/app/repositories/InventoryEventRepository.js'
import MaterialCatalogService from '../../../src/app/services/MaterialCatalogService.js'
import StockReportService from '../../../src/app/services/StockReportService.js'

import WarehouseRepository from '../../../src/app/repositories/WarehouseRepository.js'
import MaterialCategoryRepository from '../../../src/app/repositories/MaterialCategoryRepository.js'
import MaterialBalanceRepository from '../../../src/app/repositories/MaterialBalanceRepository.js'
const enabled = process.env.RUN_POSTGRES_STOCK_INTEGRATION === '1'
  && process.env.ALLOW_DISPOSABLE_POSTGRES_STOCK_TESTS === '1'

test('PostgreSQL concurrently rejects duplicate material code with atomic initial balance and OPENING', { skip: !enabled }, async () => {
  assert.equal(process.env.DB_HOST, '127.0.0.1')
  assert.equal(process.env.DB_PORT, '5434')
  assert.equal(process.env.DB_DATABASE, 'alvesglass_test')

  const container = JSON.parse(execFileSync('docker', ['inspect', 'postgres-alves-glass-test'], { encoding: 'utf8' }))[0]
  const env = Object.fromEntries(container.Config.Env.map(value => value.split('=')))
  assert.equal(env.POSTGRES_DB, 'alvesglass_test')
  const connection = { host: '127.0.0.1', port: 5434, user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: 'alvesglass_test' }
  const admin = new pg.Client(connection)
  const ids = { user: randomUUID(), warehouse: randomUUID(), category: randomUUID() }
  const suffix = randomUUID()
  const code = `T024-${suffix}`
  const warehouseCode = `T024-WH-${suffix}`
  const categoryName = `T024 category ${suffix}`
  const userName = `T024 actor ${suffix}`
  const userEmail = `${suffix}@t024.invalid`
  const originalCreateMaterial = MaterialRepository.create
  const databaseErrors = []

  MaterialRepository.create = async (...args) => {
    try { return await originalCreateMaterial.apply(MaterialRepository, args) }
    catch (error) {
      databaseErrors.push({
        code: error.original?.code ?? error.parent?.code ?? error.code,
        constraint: error.original?.constraint ?? error.parent?.constraint ?? error.constraint,
        message: error.original?.message ?? error.parent?.message ?? error.message,
      })
      throw error
    }
  }

  await admin.connect()
  try {
    const identity = await admin.query('SELECT current_database() db, version() version')
    assert.equal(identity.rows[0].db, 'alvesglass_test')
    assert.match(identity.rows[0].version, /PostgreSQL 17/)
    const sectorId = (await admin.query("SELECT id FROM sectors WHERE code='VIDRACARIA' LIMIT 1")).rows[0]?.id
    assert.ok(sectorId, 'seeded VIDRACARIA sector is required')

    await admin.query(`INSERT INTO users
      (id,name,email,password_hash,role,status_users,update_number,created_at,updated_at)
      VALUES ($1,$2,$3,'integration-fixture-not-used','admin','active','',now(),now())`, [ids.user, userName, userEmail])
    await admin.query(`INSERT INTO warehouses
      (id,sector_id,code,name,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'ACTIVE',now(),now())`, [ids.warehouse, sectorId, warehouseCode, `T024 concurrency ${suffix}`])
    await admin.query(`INSERT INTO material_categories
      (id,warehouse_id,name,created_at,updated_at)
      VALUES ($1,$2,$3,now(),now())`, [ids.category, ids.warehouse, categoryName])

    const actor = { id: ids.user, role: 'admin' }
    const input = {
      code, name: 'Concurrent material', category_id: ids.category, unit_code: 'kg',
      min_quantity: '0', initialQuantity: '1.250',
    }
    const results = await Promise.all([
      MaterialCatalogService.createMaterial(actor, ids.warehouse, input),
      MaterialCatalogService.createMaterial(actor, ids.warehouse, input),
    ])
    const winners = results.filter(result => !result?.error)
    const conflicts = results.filter(result => result?.error === 'conflict')
    console.info('T024 concurrent material registration database diagnostics', databaseErrors)
    assert.equal(winners.length, 1, `expected one winner; results=${JSON.stringify(results)}`)
    assert.equal(conflicts.length, 1, `expected one business conflict; results=${JSON.stringify(results)}`)

    const integrity = await admin.query(`SELECT
      (SELECT count(*)::int FROM materials WHERE code=$1) materials,
      (SELECT count(*)::int FROM material_balances b JOIN materials m ON m.id=b.material_id WHERE m.code=$1) balances,
      (SELECT count(*)::int FROM inventory_events e JOIN materials m ON m.id=e.material_id WHERE m.code=$1 AND e.event_type='OPENING') openings,
      (SELECT count(*)::int FROM inventory_events e JOIN materials m ON m.id=e.material_id WHERE m.code=$1 AND e.event_type='OPENING' AND e.performed_by=$2 AND e.delta='1.250' AND e.balance_before='0' AND e.balance_after='1.250') valid_openings,
      (SELECT count(*)::int FROM inventory_events e JOIN materials m ON m.id=e.material_id WHERE m.code=$1 AND e.event_type='OPENING' AND e.sequence=1) opening_sequence`, [code, ids.user])
    assert.deepEqual(integrity.rows[0], { materials: 1, balances: 1, openings: 1, valid_openings: 1, opening_sequence: 1 })

    const balance = await admin.query(`SELECT b.quantity::text quantity
      FROM material_balances b JOIN materials m ON m.id=b.material_id WHERE m.code=$1`, [code])
    assert.equal(balance.rows[0]?.quantity, '1.250')

    const duplicate = await MaterialCatalogService.createMaterial(actor, ids.warehouse, input)
    assert.deepEqual(duplicate, { error: 'conflict' })
    const afterRetry = await admin.query(`SELECT
      (SELECT count(*)::int FROM materials WHERE code=$1) materials,
      (SELECT count(*)::int FROM inventory_events e JOIN materials m ON m.id=e.material_id WHERE m.code=$1 AND e.event_type='OPENING') openings`, [code])
    assert.deepEqual(afterRetry.rows[0], { materials: 1, openings: 1 }, 'retry cannot duplicate material or opening')

    const immutable = await admin.query('SELECT delta::text FROM inventory_events WHERE material_id=$1 AND event_type=$2', [winners[0].id, 'OPENING'])
    assert.equal(immutable.rows[0]?.delta, '1.250')

    const failedCode = `T024-ROLLBACK-${suffix}`
    const originalCreateEvent = InventoryEventRepository.create
    InventoryEventRepository.create = async () => { throw new Error('forced opening persistence failure') }
    try {
      await assert.rejects(MaterialCatalogService.createMaterial(actor, ids.warehouse, { ...input, code: failedCode }), /forced opening persistence failure/)
    } finally {
      InventoryEventRepository.create = originalCreateEvent
    }
    const rollback = await admin.query(`SELECT
      (SELECT count(*)::int FROM materials WHERE code=$1) materials,
      (SELECT count(*)::int FROM material_balances b JOIN materials m ON m.id=b.material_id WHERE m.code=$1) balances`, [failedCode])
    assert.deepEqual(rollback.rows[0], { materials: 0, balances: 0 }, 'failed OPENING rolls back material and balance')
    const reportValues = await Database.connection.transaction(async transaction => {
      const originalWarehouseLookup = WarehouseRepository.findById
      const originalCategoryLookup = MaterialCategoryRepository.findCategory
      const originalCreateEvent = InventoryEventRepository.create
      const originalMaterialCreate = MaterialRepository.create
      const originalBalanceCreate = MaterialBalanceRepository.create
      WarehouseRepository.findById = async (id, options = {}) => originalWarehouseLookup(id, { ...options, transaction })
      MaterialCategoryRepository.findCategory = async (id, options = {}) => originalCategoryLookup(id, { ...options, transaction })
      InventoryEventRepository.create = async (data, suppliedTransaction) => originalCreateEvent(data, suppliedTransaction ?? transaction)
      MaterialRepository.create = async (data, options = {}) => originalMaterialCreate(data, { ...options, transaction })
      MaterialBalanceRepository.create = async (data, options = {}) => originalBalanceCreate(data, { ...options, transaction })
      try {
      const reportMaterialId = randomUUID()
      const reportCategoryId = randomUUID()
      const reportWarehouseId = randomUUID()
      const reportUserId = randomUUID()
      const reportCode = `T037-${suffix}`
      const insert = (sql, bind) => Database.connection.query(sql, { bind, transaction })
      const fixtureWarehouse = await WarehouseRepository.findById(ids.warehouse)
      const fixtureCategory = await MaterialCategoryRepository.findCategory(ids.category)
      assert.ok(fixtureWarehouse && fixtureCategory, 'report fixture references its isolated warehouse and category')
      await insert(`INSERT INTO warehouses (id,sector_id,code,name,status,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'ACTIVE',now(),now())`, [reportWarehouseId, sectorId, `T037-WH-${suffix}`, `Report fixture ${suffix}`])
      await insert(`INSERT INTO material_categories (id,warehouse_id,name,created_at,updated_at)
        VALUES ($1,$2,$3,now(),now())`, [reportCategoryId, reportWarehouseId, `T037 ${suffix}`])
      await insert(`INSERT INTO users (id,name,email,password_hash,role,status_users,update_number,created_at,updated_at)
        VALUES ($1,$2,$3,'fixture','admin','active','',now(),now())`, [reportUserId, `T037 ${suffix}`, `${suffix}@t037.invalid`])
      await insert(`INSERT INTO materials (id,warehouse_id,category_id,code,name,unit_code,min_quantity,active,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'Report fixture','kg',0,true,now(),now())`, [reportMaterialId, reportWarehouseId, reportCategoryId, reportCode])
      await insert(`INSERT INTO material_balances (material_id,quantity,updated_at) VALUES ($1,'1.000',now())`, [reportMaterialId])
      const events = [
        ['OPENING','1.000','0','1.000',1,'2026-01-01T00:00:00Z'],
        ['IN','0.500','1.000','1.500',2,'2026-01-02T00:00:00Z'],
        ['OUT','-0.250','1.500','1.250',3,'2026-01-03T00:00:00Z'],
        ['RETURN','0.100','1.250','1.350',4,'2026-01-04T00:00:00Z'],
        ['ADJUSTMENT','0.050','1.350','1.400',5,'2026-01-05T00:00:00Z'],
        ['ADJUSTMENT','-0.025','1.400','1.375',6,'2026-01-06T00:00:00Z'],
      ]
      for (const [event_type, delta, balance_before, balance_after, sequence, occurred_at] of events) {
        await InventoryEventRepository.create({
          material_id: reportMaterialId, warehouse_id: reportWarehouseId, event_type,
          delta, balance_before, balance_after, unit_code_snapshot: 'kg',
          reason_code: 'REPORT_FIXTURE', description: 'report fixture', sequence: String(sequence),
          performed_by: reportUserId, command_origin: 'SESSION', occurred_at,
          return_of_event_id: null, compensates_event_id: null,
        }, transaction)
      }
      const result = await StockReportService.summarize(actor, {
        from: '2026-01-02T00:00:00Z', to: '2026-01-07T00:00:00Z', materialId: reportMaterialId,
      }, { transaction })
      assert.equal(result.length, 1)
      assert.equal(result[0].operational_in, '0.500', 'event exactly at exclusive upper boundary is excluded')
      return result[0]
      } finally {
        WarehouseRepository.findById = originalWarehouseLookup
        MaterialCategoryRepository.findCategory = originalCategoryLookup
        InventoryEventRepository.create = originalCreateEvent
        MaterialRepository.create = originalMaterialCreate
        MaterialBalanceRepository.create = originalBalanceCreate
      }
    }, { isolationLevel: 'READ COMMITTED' })
    assert.deepEqual({
      opening: reportValues.opening_balance, closing: reportValues.closing_balance,
      in: reportValues.operational_in, out: reportValues.operational_out,
      returns: reportValues.returns, adjustmentPositive: reportValues.adjustments_positive,
      adjustmentNegative: reportValues.adjustments_negative, openings: reportValues.openings,
      }, {
      opening: '1.000', closing: '1.375', in: '0.500', out: '0.250',
      returns: '0.100', adjustmentPositive: '0.050', adjustmentNegative: '0.025', openings: '0',
    })
  } catch (error) {
    console.error('T024 concurrent material registration diagnostic', {
      code: error.code,
      constraint: error.constraint,
      message: error.message,
      detail: error.detail,
      hint: error.hint,
      results: error.results,
    })
    throw error
  } finally {
    MaterialRepository.create = originalCreateMaterial
    await admin.end()
    await Database.connection.close()
  }
})