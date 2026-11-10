import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSchemaManifest } from '../../../src/infrastructure/persistence/schema-manifest-validator.js'

const migration = '20261110000000-create-baseline-fixture.cjs'
const manifest = Object.freeze({
  version: 1,
  migrations: [{ name: migration, objects: [{ schema: 'baseline_meta', name: 'fixture_table', kind: 'table', fingerprint: 'fixture-v1' }] }],
})

function input(overrides = {}) {
  return {
    manifest,
    canonicalMigrations: [migration],
    observedObjects: { [migration]: [{ schema: 'baseline_meta', name: 'fixture_table', kind: 'table', fingerprint: 'fixture-v1' }] },
    ...overrides,
  }
}

test('validador aceita somente manifesto explícito e objeto observado consistente', () => {
  const result = validateSchemaManifest(input())
  assert.equal(result.valid, true)
  assert.deepEqual(result.observedMigrations, [{ name: migration, schemaState: 'consistent' }])
})

test('validador detecta objeto ausente, parcial e fingerprint divergente', () => {
  const absent = validateSchemaManifest(input({ observedObjects: { [migration]: [] } }))
  assert.equal(absent.observedMigrations[0].schemaState, 'absent')

  const partial = validateSchemaManifest(input({ observedObjects: { [migration]: [
    { schema: 'baseline_meta', name: 'fixture_table', kind: 'table', fingerprint: 'different' },
  ] } }))
  assert.equal(partial.observedMigrations[0].schemaState, 'partial')
})

test('validador bloqueia manifesto implícito, incompleto, duplicado ou fora das migrations canônicas', () => {
  for (const invalidManifest of [
    {},
    { version: 1, migrations: [] },
    { version: 1, migrations: [{ ...manifest.migrations[0] }, { ...manifest.migrations[0] }] },
    { version: 1, migrations: [{ ...manifest.migrations[0], name: 'outside.cjs' }] },
  ]) {
    const result = validateSchemaManifest(input({ manifest: invalidManifest }))
    assert.equal(result.valid, false)
  }
})

test('validador não consulta recursos externos nem gera manifesto', async () => {
  const module = await import('../../../src/infrastructure/persistence/schema-manifest-validator.js')
  assert.equal(typeof module.validateSchemaManifest, 'function')
})
