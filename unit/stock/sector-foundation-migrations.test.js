import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const migrationDir = path.join(root, 'src/database/migrations')
const migrationNames = [
  '20261111000000-create-sectors-and-warehouses.cjs',
  '20261111000100-create-sector-authorization.cjs',
]

test('foundation migrations are additive, scoped, normalized, and preserve audit history', async () => {
  const source = migrationNames.map(name => fs.readFileSync(path.join(migrationDir, name), 'utf8')).join('\n')
  for (const table of ['sectors', 'warehouses', 'user_sectors', 'sector_authorization_audits']) {
    assert.match(source, new RegExp(`createTable\\('${table}'`))
  }
  assert.match(source, /sector_id: \{ type: Sequelize\.UUID, allowNull: false, references: \{ model: 'sectors'/)
  assert.match(source, /onDelete: 'RESTRICT'/)
  assert.match(source, /lower\(btrim\(name\)\)/)
  assert.match(source, /GRANT', 'REVOKE/)
  assert.match(source, /reject_sector_audit_mutation/)
  assert.match(source, /sector_authorization_audits_no_truncate/)
  assert.doesNotMatch(source, /CREATE TABLE.*(?:Product|stock_movements)/s)
})

test('sector seed is repeatable and never deletes seeded rows on rollback', async () => {
  const seedPath = path.join(root, 'seeders/20261111000000-seed-sectors.cjs')
  const seed = createRequire(import.meta.url)(seedPath)
  const statements = []
  const queryInterface = { sequelize: { async transaction(callback) { return callback({ id: 'transaction' }) }, async query(sql, options) { statements.push({ sql, options }) } } }
  await seed.up(queryInterface, { QueryTypes: { INSERT: 'INSERT' } })
  await seed.up(queryInterface, { QueryTypes: { INSERT: 'INSERT' } })
  await seed.down(queryInterface)
  assert.equal(statements.length, 4)
  assert.ok(statements.every(({ sql }) => /ON CONFLICT \(code\) DO NOTHING/.test(sql)))
  assert.equal(statements[0].options.replacements.code, 'VIDRACARIA')
  assert.equal(statements[1].options.replacements.code, 'MARCENARIA')
})