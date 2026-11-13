import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const migrationsDir = path.join(root, 'src/database/migrations')
const configFile = path.join(root, 'src/config/sequelize-cli.cjs')

test('sequelize-cli usa um único caminho de migrations e SequelizeMeta padrão', () => {
  const rc = fs.readFileSync(path.join(root, '.sequelizerc'), 'utf8')
  const config = fs.readFileSync(configFile, 'utf8')
  assert.match(rc, /src', 'config', 'sequelize-cli\.cjs/)
  assert.match(rc, /src', 'database', 'migrations/)
  assert.match(config, /migrationStorageTableName: 'SequelizeMeta'/)
  assert.doesNotMatch(config, /Baseline|schema-manifest/)
})

test('migrations CommonJS preservam as migrations-base e incluem migrations aditivas da feature', () => {
  const files = fs.readdirSync(migrationsDir).filter(name => name.endsWith('.cjs')).sort()
  const baseFiles = [
    '20261110000000-create-users.cjs',
    '20261110000100-create-client.cjs',
    '20261110000200-create-orders-and-budgets.cjs',
    '20261110000300-create-order-details.cjs',
    '20261110000400-create-inventory.cjs',
    '20261110000500-create-auth-sessions.cjs',
  ]
  for (let i = 0; i < baseFiles.length; i += 1) assert.equal(files[i], baseFiles[i])
  const source = files.map(name => fs.readFileSync(path.join(migrationsDir, name), 'utf8')).join('\n')
  for (const table of ['users', 'client', 'order', 'budget', 'orders_products', 'order_address', 'product_category', 'category', 'Product', 'stock_movements', 'auth_sessions', 'auth_session_refresh_tokens', 'sectors', 'warehouses', 'materials', 'material_balances', 'inventory_events', 'inventory_outbox']) {
    assert.ok(source.includes(`createTable('${table}'`) || source.includes(`createTable("${table}"`), `migration creates ${table}`)
  }
  assert.doesNotMatch(source, /SequelizeMetaBaseline|schema-manifest/)
  assert.ok(files.includes('20261118000000-create-inventory-outbox.cjs'))
})