import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { execFileSync } from 'node:child_process'

const migrationName = '20261113000000-create-inventory-ledger.cjs'

test('authorized PostgreSQL target identity and ledger migration readiness (read-only)', async t => {
  const container = JSON.parse(execFileSync('docker', ['inspect', 'postgres-alves-glass-test'], { encoding: 'utf8' }))[0]
  const containerEnv = Object.fromEntries(container.Config.Env.map(value => value.split('=')))
  assert.equal(containerEnv.POSTGRES_DB, 'alvesglass_test')
  assert.equal(container.NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort, '5434')

  const db = new pg.Client({
    host: '127.0.0.1', port: 5434, user: containerEnv.POSTGRES_USER,
    password: containerEnv.POSTGRES_PASSWORD, database: 'alvesglass_test',
  })
  await db.connect()
  try {
    const identity = await db.query('SELECT current_database() AS database, version() AS version')
    assert.equal(identity.rows[0].database, 'alvesglass_test')
    assert.match(identity.rows[0].version, /PostgreSQL 17/)

    const applied = await db.query('SELECT 1 FROM "SequelizeMeta" WHERE name = $1', [migrationName])
    if (applied.rowCount === 0) {
      const tables = await db.query(`SELECT to_regclass('public.inventory_events') AS events,
        to_regclass('public.movement_idempotency') AS receipts`)
      assert.equal(tables.rows[0].events, null)
      assert.equal(tables.rows[0].receipts, null)
      const numeric = await db.query(`SELECT
        '9007199254740993.123456789012345678901'::numeric::text AS exact_value,
        ('0.1'::numeric + '0.2'::numeric)::text AS sum`)
      assert.equal(numeric.rows[0].exact_value, '9007199254740993.123456789012345678901')
      assert.equal(numeric.rows[0].sum, '0.3')
      t.skip(`ledger integration assertions require ${migrationName}; migration is intentionally not applied`)
    }

  } finally {
    await db.end()
  }
})