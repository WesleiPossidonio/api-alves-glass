import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = process.cwd()
const migrationDirectory = path.join(root, 'src/database/migrations')

test('migrations CommonJS são ordenadas e incluem as migrations aditivas atuais', async () => {
  const entries = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.cjs')).sort()
  assert.deepEqual(entries, [...entries].sort())
  const knownBase = [
    '20261110000000-create-users.cjs',
    '20261110000100-create-client.cjs',
    '20261110000200-create-orders-and-budgets.cjs',
    '20261110000300-create-order-details.cjs',
    '20261110000400-create-inventory.cjs',
    '20261110000500-create-auth-sessions.cjs',
  ]
  for (const name of knownBase) assert.ok(entries.includes(name), `migration-base ${name} permanece presente`)
  assert.ok(entries.includes('20261111000000-create-sectors-and-warehouses.cjs'))
  assert.ok(entries.includes('20261118000000-create-inventory-outbox.cjs'))

  for (const name of entries) {
    const source = await readFile(path.join(migrationDirectory, name), 'utf8')
    assert.match(source, /module\.exports\s*=\s*\{|exports\.(up|down)\s*=|async (up|down)\s*\(/, `${name} deve usar CommonJS`)
  }
})