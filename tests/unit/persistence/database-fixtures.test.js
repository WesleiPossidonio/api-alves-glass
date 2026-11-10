import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(import.meta.url)
const fixturesRoot = path.resolve(projectRoot, 'tests/support/database')
const baselineFixtures = path.resolve(fixturesRoot, 'baseline-migrations')
const legacyFixtures = path.resolve(fixturesRoot, 'legacy-migrations')
const productionBaseline = path.resolve(projectRoot, 'src/database/baseline')
const productionLegacy = path.resolve(projectRoot, 'src/database/migrations')

function loadFixture(filename, directory) {
  return require(path.resolve(directory, filename))
}

test('T032 mantém fixtures exclusivamente em suporte de teste e separa baseline de legado', () => {
  const baselineEntries = fs.readdirSync(baselineFixtures).sort()
  const legacyEntries = fs.readdirSync(legacyFixtures).sort()

  assert.deepEqual(baselineEntries, [
    '20261110000000-create-baseline-fixture.cjs',
    '20261110000001-controlled-partial-failure.cjs',
  ])
  assert.deepEqual(legacyEntries, ['20261110000000-create-legacy-fixture.cjs'])
  assert.deepEqual(fs.readdirSync(productionBaseline).filter(name => name !== '.gitkeep' && name !== 'config.cjs').sort(), [
    '20261110000000-create-baseline-foundation.cjs',
    'schema-manifest.json',
  ])
  assert.equal(fs.statSync(productionLegacy).isDirectory(), true)
})

test('T032 declara fixture baseline e fixture legada independentes sem executá-las', () => {
  const baseline = loadFixture('20261110000000-create-baseline-fixture.cjs', baselineFixtures)
  const legacy = loadFixture('20261110000000-create-legacy-fixture.cjs', legacyFixtures)

  assert.equal(typeof baseline.up, 'function')
  assert.equal(typeof baseline.down, 'function')
  assert.equal(typeof legacy.up, 'function')
  assert.equal(typeof legacy.down, 'function')
})

test('T032 preserva fixture de falha parcial controlada sem execução na importação', async () => {
  const partial = loadFixture('20261110000001-controlled-partial-failure.cjs', baselineFixtures)
  assert.equal(typeof partial.up, 'function')
  assert.equal(typeof partial.down, 'function')

  const calls = []
  await assert.rejects(
    partial.up({ createTable: async name => calls.push(name) }, { INTEGER: 'INTEGER' }),
    /controlled baseline fixture failure/,
  )
  assert.deepEqual(calls, ['_baseline_partial_fixture_probe'])
})