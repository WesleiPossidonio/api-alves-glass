import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { execFileSync } from 'node:child_process'

const enabled = process.env.RUN_POSTGRES_STOCK_INTEGRATION === '1'

test('material schema constraints on explicitly approved PostgreSQL test database', { skip: !enabled }, async () => {
  assert.equal(process.env.DB_HOST, '127.0.0.1', 'DB_HOST must explicitly target loopback')
  assert.equal(process.env.DB_PORT, '5434', 'DB_PORT must explicitly target approved test port')
  assert.equal(process.env.DB_DATABASE, 'alvesglass_test', 'DB_DATABASE must explicitly name the isolated test database')
  const container = JSON.parse(execFileSync('docker', ['inspect', 'postgres-alves-glass-test'], { encoding: 'utf8' }))[0]
  const containerEnv = Object.fromEntries(container.Config.Env.map(value => value.split('=')))
  assert.equal(containerEnv.POSTGRES_DB, 'alvesglass_test')
  const db = new pg.Client({ host: '127.0.0.1', port: 5434, user: containerEnv.POSTGRES_USER, password: containerEnv.POSTGRES_PASSWORD, database: 'alvesglass_test' })
  await db.connect()
  const expectReject = async (sql, values, code, label) => {
    await db.query('SAVEPOINT constraint_check')
    try {
      await db.query(sql, values)
      assert.fail(`${label} should be rejected`)
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error
      assert.equal(error.code, code, label)
    } finally {
      await db.query('ROLLBACK TO SAVEPOINT constraint_check')
      await db.query('RELEASE SAVEPOINT constraint_check')
    }
  }

  try {
    const identity = await db.query('SELECT current_database() AS db, version() AS version')
    assert.equal(identity.rows[0].db, 'alvesglass_test')
    assert.match(identity.rows[0].version, /PostgreSQL 17/)
    const applied = await db.query('SELECT name FROM "SequelizeMeta" WHERE name IN ($1, $2, $3)', [
      '20261112000000-create-material-taxonomy.cjs',
      '20261112000100-create-materials-and-balances.cjs',
      '20261112000200-add-material-balance-updated-at.cjs',
    ])
    assert.equal(applied.rowCount, 3, 'all material migrations must be applied before integration checks')

    await db.query('BEGIN')
    const sector = (await db.query("SELECT id FROM sectors WHERE code = 'VIDRACARIA' LIMIT 1")).rows[0]?.id
    assert.ok(sector, 'seed sector VIDRACARIA must exist')
    const warehouseSql = `INSERT INTO warehouses (id, sector_id, code, name, status, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 'ACTIVE', now(), now()) RETURNING id`
    const warehouseA = (await db.query(warehouseSql, [sector, 'IT-MAT-A', 'Integration materials A'])).rows[0].id
    const warehouseB = (await db.query(warehouseSql, [sector, 'IT-MAT-B', 'Integration materials B'])).rows[0].id
    const categorySql = `INSERT INTO material_categories (id, warehouse_id, name, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, now(), now()) RETURNING id`
    const categoryA = (await db.query(categorySql, [warehouseA, 'Electrical'])).rows[0].id
    await expectReject(categorySql, [warehouseA, '  electrical  '], '23505', 'category normalized uniqueness')
    const subcategoryA = (await db.query(`INSERT INTO material_subcategories
      (id, category_id, warehouse_id, name, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, 'Conduit', now(), now()) RETURNING id`, [categoryA, warehouseA])).rows[0].id
    const categoryB = (await db.query(categorySql, [warehouseB, 'Other'])).rows[0].id
    const materialSql = `INSERT INTO materials (id, warehouse_id, category_id, code, name, unit_code, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, 'IT-GLOBAL-CODE', 'Piece', 'un', now(), now())`
    await expectReject(materialSql, [warehouseB, categoryA], '23503', 'category must belong to material warehouse')
    await expectReject(`INSERT INTO materials
      (id, warehouse_id, category_id, subcategory_id, code, name, unit_code, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 'IT-CROSS-SUB', 'Cross subcategory', 'un', now(), now())`,
    [warehouseB, categoryB, subcategoryA], '23503', 'subcategory must belong to material warehouse')
    const materialId = (await db.query(`INSERT INTO materials
      (id, warehouse_id, category_id, code, name, unit_code, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, 'IT-GLOBAL-CODE', 'Piece', 'un', now(), now()) RETURNING id`,
    [warehouseA, categoryA])).rows[0].id
    await db.query('INSERT INTO material_balances (material_id, quantity, updated_at) VALUES ($1, $2, now())', [materialId, '0'])
    await expectReject('INSERT INTO material_balances (material_id, quantity, updated_at) VALUES ($1, $2, now())', [materialId, '1.1'], '23514', 'unit scale')
    await expectReject('UPDATE material_balances SET quantity = $2 WHERE material_id = $1', [materialId, '-0.001'], '23514', 'balance cannot be negative')
    await expectReject(materialSql, [warehouseA, categoryA], '23505', 'material code is globally unique')
    await db.query('ROLLBACK')
  } catch (error) {
    try { await db.query('ROLLBACK') } catch {}
    throw error
  } finally {
    await db.end()
  }
})