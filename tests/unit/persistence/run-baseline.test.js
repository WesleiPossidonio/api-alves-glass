import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBaselineArguments, runBaseline } from '../../../scripts/database/baseline/run-baseline.js'

const validEnvironment = {
  PERSISTENCE_PROFILE: 'development-rebuild',
  NODE_ENV: 'development',
  PERSISTENCE_INSTANCE_HOST: 'synthetic-host',
  PERSISTENCE_INSTANCE_PORT: '55432',
  PERSISTENCE_INSTANCE_PROFILE: 'development-rebuild',
  BASELINE_DB_HOST: 'synthetic-host',
  BASELINE_DB_PORT: '55432',
  BASELINE_DB_DATABASE: 'synthetic-baseline',
  PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE: 'synthetic-original-reference',
  BASELINE_MIGRATIONS_PATH: '/synthetic/project/src/database/baseline',
  BASELINE_IDENTITY_CONFIG_PATH: '/synthetic/identities.json',
}

test('T016 aceita somente --profile e rejeita argumentos que tentem fornecer evidências operacionais', () => {
  assert.deepEqual(parseBaselineArguments(['--profile', 'development-rebuild']), {
    valid: true,
    errors: [],
    profile: 'development-rebuild',
  })
  assert.equal(parseBaselineArguments([]).valid, false)
  assert.equal(parseBaselineArguments(['--profile', 'test', '--identity', '{}']).valid, false)
  assert.equal(parseBaselineArguments(['--profile=development-rebuild', '--profile=test']).valid, false)
})

test('T016 bloqueia com T030 ausente antes de qualquer delegação operacional', async () => {
  let loaderCalls = 0
  const result = await runBaseline({
    arguments: ['--profile', 'development-rebuild'],
    environment: validEnvironment,
    orchestratorLoader: async () => {
      loaderCalls += 1
      throw new Error('T030 unavailable')
    },
  })

  assert.equal(loaderCalls, 1)
  assert.equal(result.state, 'blocked')
  assert.equal(result.blocked, true)
  assert.match(result.errors.join('\n'), /T030 indisponível/)
})

test('T016 bloqueia perfil divergente sem carregar T030', async () => {
  let loaderCalls = 0
  const result = await runBaseline({
    arguments: ['--profile', 'test'],
    environment: validEnvironment,
    orchestratorLoader: async () => {
      loaderCalls += 1
      return { rebuildBaseline: async () => assert.fail('não deve delegar') }
    },
  })

  assert.equal(result.blocked, true)
  assert.equal(loaderCalls, 0)
  assert.match(result.errors.join('\n'), /corresponder exatamente/)
})