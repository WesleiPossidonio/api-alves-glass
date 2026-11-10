import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanupPostgresTestEnvironment, preparePostgresTestEnvironment, recordCreatedTestResource } from '../../../tests/support/database/postgres-test-environment.js'

const environment = Object.freeze({
  PERSISTENCE_PROFILE: 'test', NODE_ENV: 'test',
  PERSISTENCE_INSTANCE_HOST: 'postgres-test', PERSISTENCE_INSTANCE_PORT: '5432', PERSISTENCE_INSTANCE_PROFILE: 'test',
  BASELINE_DB_HOST: 'postgres-test', BASELINE_DB_PORT: '5432', BASELINE_DB_DATABASE: 'alvesglass_test',
  PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE: 'legacy-development-alvesglass',
  BASELINE_MIGRATIONS_PATH: '/synthetic/project/src/database/baseline', BASELINE_IDENTITY_CONFIG_PATH: '/synthetic/identities.json',
})
const target = Object.freeze({ environment: 'test', host: 'postgres-test', port: 5432, database: 'alvesglass_test', profile: 'test' })
const original = Object.freeze({ environment: 'development', host: 'postgres', port: 5432, database: 'alvesglass', profile: 'development-rebuild', reference: 'legacy-development-alvesglass' })
const authorizationConfig = Object.freeze({ allowlist: [target], denylist: [original] })
const databaseState = Object.freeze({ exists: true, isEmpty: true, identity: target })

function prepare(overrides = {}) {
  return preparePostgresTestEnvironment({
    environment,
    authorizationConfig,
    effectiveIdentity: target,
    databaseState,
    executionId: 'unit-run-1',
    ...overrides,
  })
}

test('T048 valida perfil, identidade e estado vazio antes de setup sem conexão', () => {
  const result = prepare()
  assert.equal(result.blocked, false)
  assert.equal(result.state, 'validated')
  assert.equal(typeof result.details.tracker, 'object')

  for (const overrides of [
    { environment: { ...environment, PERSISTENCE_PROFILE: 'development-rebuild', NODE_ENV: 'development', PERSISTENCE_INSTANCE_PROFILE: 'development-rebuild' } },
    { effectiveIdentity: original },
    { databaseState: { ...databaseState, isEmpty: false } },
  ]) {
    assert.equal(prepare(overrides).blocked, true)
  }
})

test('T048 rastreia somente recibos comprovados da execução corrente, sem inferir ownership por nome', () => {
  const prepared = prepare({ executionId: 'unit-run-2' })
  const tracker = prepared.details.tracker

  assert.equal(recordCreatedTestResource({
    tracker,
    receipt: { executionId: 'other-run', createdByCurrentExecution: true, kind: 'table', identifier: 'looks-owned' },
  }).blocked, true)
  assert.equal(recordCreatedTestResource({
    tracker,
    receipt: { executionId: 'unit-run-2', createdByCurrentExecution: false, kind: 'table', identifier: 'looks-owned' },
  }).blocked, true)
  assert.equal(recordCreatedTestResource({
    tracker,
    receipt: { executionId: 'unit-run-2', createdByCurrentExecution: true, kind: 'table', identifier: 'fixture_table' },
  }).blocked, false)
})

test('T048 revalida identidade antes de cleanup e delega somente recursos próprios sem DROP DATABASE', async () => {
  const prepared = prepare({ executionId: 'unit-run-3' })
  const tracker = prepared.details.tracker
  recordCreatedTestResource({
    tracker,
    receipt: { executionId: 'unit-run-3', createdByCurrentExecution: true, kind: 'schema', identifier: 'fixture_schema' },
  })
  const calls = []

  const blocked = await cleanupPostgresTestEnvironment({
    environment,
    authorizationConfig,
    effectiveIdentity: original,
    tracker,
    resourceExecutor: { async cleanupOwnedResources(resources) { calls.push(resources) } },
  })
  assert.equal(blocked.blocked, true)
  assert.deepEqual(calls, [])

  const cleaned = await cleanupPostgresTestEnvironment({
    environment,
    authorizationConfig,
    effectiveIdentity: target,
    tracker,
    resourceExecutor: { async cleanupOwnedResources(resources) { calls.push(resources) } },
  })
  assert.equal(cleaned.blocked, false)
  assert.deepEqual(calls, [[{ kind: 'schema', identifier: 'fixture_schema' }]])
})

test('T048 bloqueia executor ausente e importação não abre conexão ou limpa recursos', async () => {
  const prepared = prepare({ executionId: 'unit-run-4' })
  const blocked = await cleanupPostgresTestEnvironment({
    environment, authorizationConfig, effectiveIdentity: target, tracker: prepared.details.tracker,
  })
  assert.equal(blocked.blocked, true)
  assert.match(blocked.errors.join('\n'), /Executor explícito/)

  const module = await import('../../../tests/support/database/postgres-test-environment.js')
  assert.equal(typeof module.preparePostgresTestEnvironment, 'function')
})