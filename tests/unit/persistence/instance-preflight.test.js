import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizeTargetIdentity, validateAuthorizationLists } from '../../../src/infrastructure/persistence/target-identity.js'
import { runInstancePreflight } from '../../../src/infrastructure/persistence/instance-preflight.js'
import { runDatabasePreflight } from '../../../src/infrastructure/persistence/database-preflight.js'

const environment = Object.freeze({
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
})

const target = Object.freeze({
  environment: 'development', host: 'synthetic-host', port: 55432,
  database: 'synthetic-baseline', profile: 'development-rebuild',
})

const original = Object.freeze({
  environment: 'production', host: 'synthetic-original-host', port: 5432,
  database: 'synthetic-original', profile: 'production', reference: 'synthetic-original-reference',
})

const authorizationConfig = Object.freeze({ allowlist: [target], denylist: [original] })

test('T018 bloqueia allowlist/denylist ausentes, vazias, ambíguas ou inconsistentes', () => {
  for (const input of [
    {},
    { allowlist: [], denylist: [original], protectedOriginalReference: original.reference },
    { allowlist: [target], denylist: [], protectedOriginalReference: original.reference },
    { allowlist: [target, { ...target }], denylist: [original], protectedOriginalReference: original.reference },
    { allowlist: [target], denylist: [original, { ...original }], protectedOriginalReference: original.reference },
    { allowlist: [target], denylist: [{ ...target, reference: original.reference }], protectedOriginalReference: original.reference },
    { allowlist: [target], denylist: [original], protectedOriginalReference: 'missing-reference' },
  ]) {
    assert.equal(validateAuthorizationLists(input).valid, false)
  }
})

test('T018 bloqueia destino protegido ou não autorizado', () => {
  assert.equal(authorizeTargetIdentity(original, {
    allowlist: [target], denylist: [original], protectedOriginalReference: original.reference,
  }).authorized, false)
  assert.equal(authorizeTargetIdentity({ ...target, database: 'other-db' }, {
    allowlist: [target], denylist: [original], protectedOriginalReference: original.reference,
  }).authorized, false)
})

test('T018 bloqueia perfil administrativo inadequado e identidade efetiva divergente', () => {
  assert.equal(runInstancePreflight({
    environment: { ...environment, PERSISTENCE_PROFILE: 'test', PERSISTENCE_INSTANCE_PROFILE: 'test', NODE_ENV: 'test' },
    authorizationConfig,
    effectiveIdentity: { ...target, environment: 'test', profile: 'test' },
  }).blocked, true)

  const divergent = runInstancePreflight({
    environment,
    authorizationConfig,
    effectiveIdentity: { ...target, host: 'other-host' },
  })
  assert.equal(divergent.blocked, true)
  assert.match(divergent.errors.join('\n'), /diverge/)
})

test('T018 bloqueia estado de banco ausente, inexistente ou não vazio no preflight de database', () => {
  const base = { environment, authorizationConfig }
  assert.equal(runDatabasePreflight(base).blocked, true)
  assert.equal(runDatabasePreflight({ ...base, databaseState: { exists: false, isEmpty: true, identity: target } }).blocked, true)
  assert.equal(runDatabasePreflight({ ...base, databaseState: { exists: true, isEmpty: false, identity: target } }).blocked, true)
})

test('T018 documenta limite: fixture válida prova mecanismo, não comprovação operacional independente', () => {
  const syntheticAuthorization = runInstancePreflight({
    environment,
    authorizationConfig,
    effectiveIdentity: target,
  })
  assert.equal(syntheticAuthorization.state, 'instance-validated')
  assert.equal(syntheticAuthorization.blocked, false)
  assert.equal(syntheticAuthorization.details.target.host, 'synthetic-host')
})