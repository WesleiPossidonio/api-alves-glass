import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { createPostgresAuthenticatedReadOnlyExecutor, POSTGRES_READ_ONLY_QUERIES } from '../../../src/infrastructure/persistence/postgres-authenticated-read-only-executor.js'

const target = Object.freeze({ environment: 'test', host: 'postgres-test', port: 5432, database: 'alvesglass_test', profile: 'test' })
const authorizationConfig = Object.freeze({
  allowlist: [target],
  denylist: [{ environment: 'production', host: 'postgres-original', port: 5432, database: 'alvesglass', profile: 'production', reference: 'original' }],
  protectedOriginalReference: 'original',
})
const migration = '20261110000000-create-baseline-fixture.cjs'
const manifest = Object.freeze({ version: 1, migrations: [{ name: migration, objects: [{ schema: 'baseline_meta', name: 'fixture_table', kind: 'table', fingerprint: 'fixture-v1' }] }] })
const keys = generateKeyPairSync('ed25519')
const WRITE_OR_DDL_COMMAND = /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => ({ ...result, [key]: canonicalize(value[key]) }), {})
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)) }
function attestation() {
  const payload = { version: 1, profile: 'test', issuedAt: '2026-11-09T11:59:00.000Z', expiresAt: '2099-11-09T12:05:00.000Z', nonce: 'nonce', declaredTarget: target, docker: { containerId: 'container', networkId: 'network', networkEndpointId: 'endpoint', networkAddress: '172.24.0.2', service: 'postgres-test' }, postgres: { serverAddress: '172.24.0.2', serverPort: 5432 } }
  const fingerprint = createHash('sha256').update(canonicalJson(payload)).digest('hex')
  const signed = { ...payload, fingerprint }
  return { ...signed, signature: { algorithm: 'ed25519', keyId: 'key', value: sign(null, Buffer.from(canonicalJson(signed)), keys.privateKey).toString('base64') } }
}

function metadataEvidence() {
  return { resolvedRelation: 'baseline_meta.SequelizeMetaBaseline', resolution: { qualified: true, searchPathUsed: false }, schema: { name: 'baseline_meta', exists: true }, table: { schema: 'baseline_meta', name: 'SequelizeMetaBaseline', exists: true }, nameColumn: { exists: true, nullable: false }, constraints: [{ type: 'PRIMARY KEY', columns: ['name'] }] }
}

function createFakeClient(overrides = {}) {
  const calls = []
  const client = {
    async connect() { calls.push('connect'); if (overrides.connectError) throw overrides.connectError },
    async end() { calls.push('end'); if (overrides.endError) throw overrides.endError },
    async query(query) {
      const text = typeof query === 'string' ? query : query.text
      calls.push(text)
      if (overrides.queryError?.test?.(text)) throw overrides.queryError.error
      if (text === 'BEGIN READ ONLY' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] }
      if (text === POSTGRES_READ_ONLY_QUERIES.SESSION_SQL) return { rows: [{ currentDatabase: target.database, currentUser: 'baseline_reader', transactionReadOnly: overrides.transactionReadOnly ?? 'on', serverAddress: '172.24.0.2', serverPort: 5432 }] }
      if (text === POSTGRES_READ_ONLY_QUERIES.PRIVILEGES_SQL) return { rows: [{ canCreateDatabase: false, canCreateSchema: false, canWriteMetadata: overrides.canWriteMetadata ?? false }] }
      if (text === POSTGRES_READ_ONLY_QUERIES.DATABASE_STATE_SQL) return { rows: [{ exists: true, isEmpty: false }] }
      if (text === POSTGRES_READ_ONLY_QUERIES.METADATA_SQL) return { rows: [{ evidence: metadataEvidence() }] }
      if (text === POSTGRES_READ_ONLY_QUERIES.RECORDED_MIGRATIONS_SQL) return { rows: [{ name: migration }] }
      if (text === POSTGRES_READ_ONLY_QUERIES.SCHEMA_OBJECTS_SQL) return { rows: [{ schema: 'baseline_meta', name: 'fixture_table', kind: 'table', fingerprint: overrides.fingerprint ?? 'fixture-v1' }] }
      throw new Error(`unexpected query ${text}`)
    },
  }
  return { client, calls }
}

function createExecutor(fake, overrides = {}) {
  return createPostgresAuthenticatedReadOnlyExecutor({
    connectionConfig: { host: target.host, port: target.port, database: target.database, user: 'secret-user', password: 'secret-password' },
    authorizationConfig,
    trustedPublicKeys: { key: keys.publicKey },
    getAttestation: () => attestation(),
    getNonce: () => 'nonce',
    schemaManifest: manifest,
    createClient: () => fake.client,
    ...overrides,
  })
}

async function observe(executor) {
  return executor.observeBaselineState({ declaredTarget: target, metadataRelation: 'baseline_meta.SequelizeMetaBaseline', canonicalMigrations: [migration] })
}

test('executor usa somente consultas fixas em transação READ ONLY e encerra conexão', async () => {
  const fake = createFakeClient()
  const snapshot = await observe(createExecutor(fake))
  assert.equal(snapshot.authentication.readOnly, true)
  assert.equal(snapshot.authentication.principal, 'baseline_reader')
  assert.equal(snapshot.physicalInstance.source, 'approved-endpoint-attestation')
  assert.equal(fake.calls[0], 'connect')
  assert.equal(fake.calls[1], 'BEGIN READ ONLY')
  assert.equal(fake.calls.includes('COMMIT'), true)
  assert.equal(fake.calls.at(-1), 'end')
  assert.equal(fake.calls.some(call => WRITE_OR_DDL_COMMAND.test(call)), false)
})

test('executor bloqueia sessão não read-only, privilégios excessivos e atestado inválido sem efeitos de escrita', async () => {
  const cases = [
    { fake: createFakeClient({ transactionReadOnly: 'off' }) },
    { fake: createFakeClient({ canWriteMetadata: true }) },
    { fake: createFakeClient(), overrides: { getAttestation: () => ({}) } },
  ]
  for (const item of cases) {
    await assert.rejects(() => observe(createExecutor(item.fake, item.overrides)), /bloqueada/)
    assert.equal(item.fake.calls.includes('ROLLBACK'), true)
    assert.equal(item.fake.calls.at(-1), 'end')
    assert.equal(item.fake.calls.some(call => WRITE_OR_DDL_COMMAND.test(call)), false)
  }
})

test('executor preserva schema parcial para classificação posterior como recovery-required', async () => {
  const fake = createFakeClient({ fingerprint: 'different' })
  const snapshot = await observe(createExecutor(fake))
  assert.deepEqual(snapshot.observedMigrations, [{ name: migration, schemaState: 'partial' }])
  assert.equal(fake.calls.includes('COMMIT'), true)
  assert.equal(fake.calls.includes('ROLLBACK'), false)
})

test('executor aceita somente a alternativa local Docker+sessõo no profile test e ainda exige READ ONLY', async () => {
  const fake = createFakeClient({ canWriteMetadata: true })
  const executor = createExecutor(fake, {
    localDockerEvidence: {
      containerName: 'postgres-alves-glass-test', containerId: 'container', service: 'postgres-test', composeProject: 'api-alves-glass-clone',
      networkName: 'api-alves-glass-clone_persistence-test-network', networkId: 'network', networkEndpointId: 'endpoint', networkAddress: '172.24.0.2',
    },
  })
  const snapshot = await observe(executor)
  assert.equal(snapshot.physicalInstance.source, 'local-docker-session-verification')
  assert.equal(snapshot.authentication.readOnly, true)
})

test('executor sanitiza falha de conexão, encerra quando possível e não aceita destino protegido', async () => {
  const failing = createFakeClient({ connectError: new Error('password=super-secret postgresql://reader:super-secret@postgres-test:5432/alvesglass_test') })
  await assert.rejects(() => observe(createExecutor(failing)), error => !error.message.includes('super-secret') && /REDACTED/.test(error.message))
  assert.deepEqual(failing.calls, ['connect', 'end'])

  const fake = createFakeClient()
  const executor = createExecutor(fake)
  await assert.rejects(() => executor.observeBaselineState({ declaredTarget: authorizationConfig.denylist[0], metadataRelation: 'baseline_meta.SequelizeMetaBaseline', canonicalMigrations: [migration] }), /T006/)
  assert.deepEqual(fake.calls, [])
})

test('importação e fábrica não conectam e executor não expõe APIs de escrita', async () => {
  let created = 0
  const executor = createPostgresAuthenticatedReadOnlyExecutor({ connectionConfig: {}, authorizationConfig, trustedPublicKeys: { key: keys.publicKey }, getAttestation: () => attestation(), getNonce: () => 'nonce', schemaManifest: manifest, createClient: () => { created += 1; return createFakeClient().client } })
  assert.equal(created, 0)
  assert.equal(typeof executor.write, 'undefined')
  assert.equal(typeof executor.apply, 'undefined')
  assert.equal(typeof executor.cleanup, 'undefined')
  const module = await import('../../../src/infrastructure/persistence/postgres-authenticated-read-only-executor.js')
  assert.equal(typeof module.createPostgresAuthenticatedReadOnlyExecutor, 'function')
})
