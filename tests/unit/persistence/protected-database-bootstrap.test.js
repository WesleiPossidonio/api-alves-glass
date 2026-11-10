import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizeProtectedDatabaseBootstrap, createProtectedDatabase, validatePostgresIdentifier } from '../../../src/infrastructure/persistence/protected-database-bootstrap.js'

const environment = Object.freeze({
  PERSISTENCE_PROFILE: 'development-rebuild', NODE_ENV: 'development',
  PERSISTENCE_INSTANCE_HOST: 'synthetic-host', PERSISTENCE_INSTANCE_PORT: '55432', PERSISTENCE_INSTANCE_PROFILE: 'development-rebuild',
  BASELINE_DB_HOST: 'synthetic-host', BASELINE_DB_PORT: '55432', BASELINE_DB_DATABASE: 'synthetic-baseline',
  PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE: 'synthetic-original-reference',
  BASELINE_MIGRATIONS_PATH: '/synthetic/project/src/database/baseline', BASELINE_IDENTITY_CONFIG_PATH: '/synthetic/identities.json',
})

const target = Object.freeze({ environment: 'development', host: 'synthetic-host', port: 55432, database: 'synthetic-baseline', profile: 'development-rebuild' })
const authorizationConfig = Object.freeze({
  allowlist: [target],
  denylist: [{ environment: 'production', host: 'synthetic-original-host', port: 5432, database: 'synthetic-original', profile: 'production', reference: 'synthetic-original-reference' }],
})
const validInput = Object.freeze({ environment, authorizationConfig, effectiveIdentity: target, databaseState: { exists: false } })

test('T018 bloqueia estado ausente, banco existente e executor ausente', async () => {
  assert.equal(authorizeProtectedDatabaseBootstrap({ ...validInput, databaseState: undefined }).blocked, true)
  assert.equal(authorizeProtectedDatabaseBootstrap({ ...validInput, databaseState: { exists: true } }).blocked, true)
  assert.equal((await createProtectedDatabase(validInput)).blocked, true)
})

test('T018 bloqueia identificador PostgreSQL inválido e escapa identificador válido', () => {
  assert.equal(validatePostgresIdentifier('').valid, false)
  assert.equal(validatePostgresIdentifier('x\u0000y').valid, false)
  assert.equal(validatePostgresIdentifier('x'.repeat(64)).valid, false)
  assert.equal(validatePostgresIdentifier('safe"name').quotedIdentifier, '"safe""name"')
})

test('T018 garante que executor fake não é chamado quando autorização falha', async () => {
  let calls = 0
  const fakeExecutor = { createDatabase: async () => { calls += 1 } }
  const result = await createProtectedDatabase({
    ...validInput,
    effectiveIdentity: { ...target, database: 'unapproved' },
  }, fakeExecutor)

  assert.equal(result.blocked, true)
  assert.equal(calls, 0)
})

test('T018 executor incompatível é bloqueado antes de qualquer criação', async () => {
  const result = await createProtectedDatabase(validInput, {})
  assert.equal(result.blocked, true)
  assert.match(result.errors.join('\n'), /Executor administrativo explícito/)
})