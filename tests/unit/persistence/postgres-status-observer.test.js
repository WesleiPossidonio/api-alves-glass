import assert from 'node:assert/strict'
import test from 'node:test'
import { createAuthenticatedPostgresStatusObserver } from '../../../src/infrastructure/persistence/postgres-status-observer.js'

const target = Object.freeze({
  environment: 'test', host: 'postgres-test', port: 5432, database: 'alvesglass_test', profile: 'test',
})
const original = Object.freeze({
  environment: 'production', host: 'postgres-original', port: 5432, database: 'alvesglass', profile: 'production', reference: 'original',
})
const authorizationConfig = Object.freeze({
  allowlist: [target], denylist: [original], protectedOriginalReference: 'original',
})
const migration = '20261110000000-create-baseline-fixture.cjs'

function snapshot(overrides = {}) {
  return {
    authentication: { authenticated: true, readOnly: true, principal: 'baseline_reader' },
    connectedEndpoint: { verified: true, host: target.host, port: target.port },
    physicalInstance: { verified: true, source: 'approved-endpoint-attestation', fingerprint: 'test-instance-v1' },
    observedIdentity: target,
    databaseState: { exists: true, isEmpty: false },
    serverSession: { currentDatabase: target.database, currentUser: 'baseline_reader' },
    metadataEvidence: {
      resolvedRelation: 'baseline_meta.SequelizeMetaBaseline',
      resolution: { qualified: true, searchPathUsed: false },
      schema: { name: 'baseline_meta', exists: true },
      table: { schema: 'baseline_meta', name: 'SequelizeMetaBaseline', exists: true },
      nameColumn: { exists: true, nullable: false },
      constraints: [{ type: 'PRIMARY KEY', columns: ['name'] }],
      recordedMigrations: [migration],
    },
    observedMigrations: [{ name: migration, schemaState: 'consistent' }],
    legacyHistory: { observed: false },
    ...overrides,
  }
}

function createObserver(resultOrError, calls = []) {
  return createAuthenticatedPostgresStatusObserver({
    readOnlyExecutor: {
      async observeBaselineState(request) {
        calls.push(request)
        if (resultOrError instanceof Error) throw resultOrError
        return resultOrError
      },
    },
  })
}

async function observe(observer, overrides = {}) {
  return observer.observeBaselineStatus({
    declaredTarget: target,
    authorizationConfig,
    canonicalMigrations: [migration],
    ...overrides,
  })
}

test('observador autenticado produz evidência read-only completa sem expor escrita', async () => {
  const calls = []
  const observer = createObserver(snapshot(), calls)
  const result = await observe(observer)

  assert.equal(result.blocked, false)
  assert.equal(result.state, 'validated')
  assert.equal(result.details.databaseState.isEmpty, false)
  assert.equal(result.details.metadataValidation.state, 'validated')
  assert.deepEqual(result.details.recoveryEvidence.canonicalMigrations, [migration])
  assert.equal(typeof observer.write, 'undefined')
  assert.equal(typeof observer.apply, 'undefined')
  assert.equal(typeof observer.cleanup, 'undefined')
  assert.deepEqual(calls[0], {
    declaredTarget: target,
    metadataRelation: 'baseline_meta.SequelizeMetaBaseline',
    canonicalMigrations: [migration],
  })
})

test('observador bloqueia identidade protegida, endpoint/identidade divergentes e evidência incompleta antes de aceitar status', async () => {
  const protectedCalls = []
  const protectedObserver = createObserver(snapshot(), protectedCalls)
  const protectedResult = await observe(protectedObserver, { declaredTarget: original })
  assert.equal(protectedResult.blocked, true)
  assert.equal(protectedCalls.length, 0)

  for (const evidence of [
    snapshot({ connectedEndpoint: { verified: true, host: 'other-host', port: target.port } }),
    snapshot({ observedIdentity: { ...target, database: 'other-db' } }),
    snapshot({ physicalInstance: { verified: false } }),
    snapshot({ authentication: { authenticated: true, readOnly: false, principal: 'writer' } }),
  ]) {
    const result = await observe(createObserver(evidence))
    assert.equal(result.blocked, true)
  }
})

test('observador bloqueia metadata inválida e não aceita search_path como isolamento', async () => {
  for (const metadataEvidence of [
    { ...snapshot().metadataEvidence, resolution: { qualified: false, searchPathUsed: true } },
    { ...snapshot().metadataEvidence, table: { schema: 'public', name: 'SequelizeMetaBaseline', exists: true } },
    { ...snapshot().metadataEvidence, constraints: [{ type: 'UNIQUE', columns: ['other'] }] },
  ]) {
    const result = await observe(createObserver(snapshot({ metadataEvidence })))
    assert.equal(result.blocked, true)
    assert.match(result.errors.join('\n'), /search_path|metadata|schema|name/)
  }
})

test('observador preserva divergência de histórico para T029 e bloqueia snapshot incompleto ou banco vazio', async () => {
  const divergent = await observe(createObserver(snapshot({
    metadataEvidence: { ...snapshot().metadataEvidence, recordedMigrations: [] },
    observedMigrations: [{ name: migration, schemaState: 'consistent' }],
  })))
  assert.equal(divergent.blocked, false)
  assert.equal(divergent.details.recoveryEvidence.observedMigrations[0].metadataRecorded, false)

  const incomplete = await observe(createObserver(snapshot({ observedMigrations: [] })))
  assert.equal(incomplete.blocked, true)
  assert.match(incomplete.errors.join('\n'), /incompleto/)

  const empty = await observe(createObserver(snapshot({ databaseState: { exists: true, isEmpty: true } })))
  assert.equal(empty.blocked, true)
  assert.match(empty.errors.join('\n'), /inicializado|vazio/)
})

test('observador bloqueia falha de autenticação do executor, redige credenciais e não conecta por importação', async () => {
  const result = await observe(createObserver(new Error('password=super-secret postgresql://reader:super-secret@postgres-test:5432/alvesglass_test')))
  assert.equal(result.blocked, true)
  assert.equal(result.errors.join('\n').includes('super-secret'), false)
  assert.match(result.errors.join('\n'), /\[REDACTED\]|\[DATABASE_URL_REDACTED\]/)

  const module = await import('../../../src/infrastructure/persistence/postgres-status-observer.js')
  assert.equal(typeof module.createAuthenticatedPostgresStatusObserver, 'function')
})