import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import Database from '../../../src/database/index.js'
import StockReportService from '../../../src/app/services/StockReportService.js'
import InventoryEventRepository from '../../../src/app/repositories/InventoryEventRepository.js'
import UserSectorRepository from '../../../src/app/repositories/UserSectorRepository.js'

const enabled = process.env.RUN_POSTGRES_FEATURE003_INTEGRATION === '1'
const isolatedIntegrationTarget = process.env.DB_PORT === '55438' && process.env.DB_DATABASE === 'feature003_integration'

test('Feature 003 reports reconcile ledger, enforce filters and paginate on explicitly disposable PostgreSQL', { skip: !enabled }, async () => {
  assert.equal(process.env.DB_HOST, '127.0.0.1')
  assert.equal(process.env.DB_PORT, isolatedIntegrationTarget ? '55438' : '55437')
  assert.equal(process.env.DB_DATABASE, isolatedIntegrationTarget ? 'feature003_integration' : 'feature003_ephemeral')
  const admin = new pg.Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_DATABASE, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD })
  await admin.connect()
  const identity = await admin.query('SELECT current_database() db, current_user usr, version() version')
    assert.equal(identity.rows[0].db, process.env.DB_DATABASE)
  assert.match(identity.rows[0].version, /PostgreSQL 17/)

  const ids = { user: randomUUID(), sector: randomUUID(), warehouse: randomUUID(), category: randomUUID(), material: randomUUID() }
  const stamp = `F003-${randomUUID().slice(0, 8)}`
  const actor = { id: ids.user, role: 'user' }
  const originals = { grants: UserSectorRepository.findSectorIdsByUser }
  const Reports = (await import('../../../src/app/services/StockReportService.js')).default
  const Repository = (await import('../../../src/app/repositories/InventoryEventRepository.js')).default
  const projection = (await import('../../../src/app/services/InventoryProjectionService.js')).default
  const originalSummary = Repository.summarizeByPeriod
  const originalPage = Repository.findStatementPage
  const previousProjectionConnections = projection.connections
  try {
    await admin.query(`INSERT INTO users (id,name,email,password_hash,role,status_users,update_number,created_at,updated_at)
      VALUES ($1,$2,$3,'test-hash','user','active','',now(),now())`, [ids.user, `${stamp} user`, `${stamp.toLowerCase()}@example.test`])
    await admin.query(`INSERT INTO sectors (id,code,name,created_at,updated_at) VALUES ($1,$2,$3,now(),now())`, [ids.sector, stamp, `${stamp} sector`])
    await admin.query(`INSERT INTO warehouses (id,sector_id,code,name,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'ACTIVE',now(),now())`, [ids.warehouse, ids.sector, stamp, `${stamp} warehouse`])
    await admin.query(`INSERT INTO material_categories (id,warehouse_id,name,created_at,updated_at) VALUES ($1,$2,$3,now(),now())`, [ids.category, ids.warehouse, `${stamp} category`])
    await admin.query(`INSERT INTO materials (id,warehouse_id,category_id,code,name,unit_code,min_quantity,active,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'kg',0,true,now(),now())`, [ids.material, ids.warehouse, ids.category, stamp, `${stamp} material`])
    await admin.query(`INSERT INTO material_balances (material_id,quantity,updated_at) VALUES ($1,'0.3',now())`, [ids.material])
    const occurredAt = '2026-01-10T15:00:00.000Z'
    for (const [sequence, eventType, delta, before, after, date, description] of [
      [1, 'OPENING', '0.3', '0', '0.3', occurredAt, 'F003 opening'],
      [2, 'IN', '0.2', '0.3', '0.5', '2026-01-12T15:00:00.000Z', 'F003 receipt'],
      [3, 'OUT', '-0.2', '0.5', '0.3', '2026-01-14T15:00:00.000Z', 'F003 issue'],
    ]) await admin.query(`INSERT INTO inventory_events (id,material_id,warehouse_id,event_type,delta,balance_before,balance_after,unit_code_snapshot,description,sequence,performed_by,command_origin,occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'kg',$8,$9,$10,'SESSION',$11)`,
    [randomUUID(), ids.material, ids.warehouse, eventType, delta, before, after, description, sequence, ids.user, date])

    UserSectorRepository.findSectorIdsByUser = async userId => userId === ids.user ? [ids.sector] : []
    projection.connections = { getMongoDatabase: async () => ({ collection: () => ({
      findOne: async () => null,
      find: () => ({ sort() { return this }, limit() { return this }, toArray: async () => [] }),
    }) }) }
    process.env.STOCK_REPORT_CURSOR_SECRET ??= 'feature003-only-cursor-hmac-test-secret-32-bytes'
    const summary = await Reports.summarize({ id: ids.user, role: 'admin' }, { from: '2026-01-01', to: '2026-02-01', warehouseId: ids.warehouse, materialId: ids.material })
    assert.equal(summary.length, 1)
    assert.equal(summary[0].unit_code, 'kg')
    assert.equal(String(summary[0].operational_in), '0.2')
    assert.equal(String(summary[0].operational_out), '0.2')
    assert.equal(String(summary[0].opening_balance), '0')
    assert.equal(String(summary[0].closing_balance), '0.3')

    const first = await Reports.statement({ id: ids.user, role: 'admin' }, { from: '2026-01-01', to: '2026-02-01', materialId: ids.material, limit: 2 }, { now: () => new Date('2026-02-02T00:00:00Z') })
    assert.equal(first.data.length, 2)
    assert.ok(first.nextCursor)
    // New normal-time event after page one is excluded by fixed asOf; retroactive and late commit limitations are tested/documented separately.
    const lateId = randomUUID()
    await admin.query(`INSERT INTO inventory_events (id,material_id,warehouse_id,event_type,delta,balance_before,balance_after,unit_code_snapshot,description,sequence,performed_by,command_origin,occurred_at)
      VALUES ($1,$2,$3,'IN','0.1','0.3','0.4','kg','after asOf','4',$4,'SESSION','2026-02-03T00:00:00Z')`, [lateId, ids.material, ids.warehouse, ids.user])
    const second = await Reports.statement({ id: ids.user, role: 'admin' }, { from: '2026-01-01', to: '2026-02-01', materialId: ids.material, limit: 2, cursor: first.nextCursor }, { now: () => new Date('2026-02-05T00:00:00Z') })
    assert.equal(second.data.length, 1)
    assert.equal(second.data.some(row => row.id === lateId), false)
    assert.deepEqual(await Reports.statement({ id: ids.user, role: 'admin' }, { from: '2026-01-01', to: '2026-02-01', materialId: ids.material, limit: 2, type: 'OUT', cursor: first.nextCursor }), { error: 'validation' })
    UserSectorRepository.findSectorIdsByUser = async () => []
    assert.deepEqual(await Reports.statement(actor, { from: '2026-01-01', to: '2026-02-01', materialId: ids.material }), { data: [], nextCursor: null })

    const boundary = await Reports.summarize({ id: randomUUID(), role: 'admin' }, { from: '2025-01-31', to: '2026-01-31' })
    assert.ok(Array.isArray(boundary))
    assert.deepEqual(await Reports.summarize({ id: randomUUID(), role: 'admin' }, { from: '2025-01-01', to: '2026-02-02' }), { error: 'validation' })
  } finally {
    UserSectorRepository.findSectorIdsByUser = originals.grants
    if (typeof originalSummary === 'function') Repository.summarizeByPeriod = originalSummary
    if (typeof originalPage === 'function') Repository.findStatementPage = originalPage
    projection.connections = previousProjectionConnections
    await admin.end()
    await Database.connection.close()
  }
})