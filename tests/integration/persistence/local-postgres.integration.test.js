import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import test from 'node:test'
import pg from 'pg'
import { runDatabasePreflight } from '../../../src/infrastructure/persistence/database-preflight.js'
import { authorizeProtectedDatabaseBootstrap } from '../../../src/infrastructure/persistence/protected-database-bootstrap.js'
import { validateBaselineMetadata } from '../../../src/infrastructure/persistence/metadata-validator.js'
import { diagnoseMigrationRecovery } from '../../../src/infrastructure/persistence/migration-recovery.js'
import { verifyLocalDockerSessionIdentity } from '../../../src/infrastructure/persistence/test-endpoint-attestation.js'
import { runStatusBaseline } from '../../../scripts/database/baseline/status-baseline.js'

const execute = promisify(execFile)
const migration = '20261110000000-create-baseline-fixture.cjs'
const partialMigration = '20261110000001-controlled-partial-failure.cjs'
const canonicalMigration = '20261110000000-create-baseline-foundation.cjs'
const target = Object.freeze({ environment: 'test', host: 'postgres-test', port: 5432, database: 'alvesglass_test', profile: 'test' })
const authorizationConfig = Object.freeze({
  allowlist: [target],
  denylist: [{ environment: 'development', host: 'postgres', port: 5432, database: 'alvesglass', profile: 'legacy-development', reference: 'legacy-development-alvesglass' }],
  protectedOriginalReference: 'legacy-development-alvesglass',
})
const environment = Object.freeze({
  ...process.env,
  NODE_ENV: 'test',
  PERSISTENCE_PROFILE: 'test',
  PERSISTENCE_INSTANCE_HOST: 'postgres-test',
  PERSISTENCE_INSTANCE_PORT: '5432',
  PERSISTENCE_INSTANCE_PROFILE: 'test',
  BASELINE_DB_HOST: 'postgres-test',
  BASELINE_DB_PORT: '5432',
  BASELINE_DB_DATABASE: 'alvesglass_test',
  PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE: 'legacy-development-alvesglass',
  BASELINE_MIGRATIONS_PATH: '/app/src/database/baseline',
  BASELINE_IDENTITY_CONFIG_PATH: '/app/.baseline-identity.json',
})
const evidence = JSON.parse(process.env.BASELINE_LOCAL_DOCKER_EVIDENCE ?? '{}')
const client = new pg.Client({ host: target.host, port: target.port, database: target.database, user: process.env.BASELINE_DB_USERNAME, password: process.env.BASELINE_DB_PASSWORD })
const executionId = randomUUID()
const owned = new Set()

async function query(text, values) { return client.query(text, values) }
async function userObjectCount() {
  const { rows: [row] } = await query("SELECT count(*)::int AS count FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')")
  return row.count
}
async function observeMetadata() {
  const { rows: [row] } = await query(`SELECT json_build_object(
    'resolvedRelation', 'baseline_meta.SequelizeMetaBaseline',
    'resolution', json_build_object('qualified', true, 'searchPathUsed', false),
    'schema', json_build_object('name', 'baseline_meta', 'exists', EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'baseline_meta')),
    'table', json_build_object('schema', 'baseline_meta', 'name', 'SequelizeMetaBaseline', 'exists', EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'baseline_meta' AND c.relname = 'SequelizeMetaBaseline' AND c.relkind = 'r')),
    'nameColumn', json_build_object('exists', EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'baseline_meta' AND c.relname = 'SequelizeMetaBaseline' AND a.attname = 'name' AND a.attnum > 0 AND NOT a.attisdropped), 'nullable', COALESCE((SELECT NOT a.attnotnull FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'baseline_meta' AND c.relname = 'SequelizeMetaBaseline' AND a.attname = 'name' AND a.attnum > 0 AND NOT a.attisdropped), true)),
    'constraints', COALESCE((SELECT json_agg(json_build_object('type', CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE' END, 'columns', con.columns)) FROM (SELECT con.contype, array_agg(att.attname ORDER BY keys.ordinality) AS columns FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid JOIN unnest(con.conkey) WITH ORDINALITY keys(attnum, ordinality) ON true JOIN pg_catalog.pg_attribute att ON att.attrelid = rel.oid AND att.attnum = keys.attnum WHERE rel.relnamespace = 'baseline_meta'::regnamespace AND rel.relname = 'SequelizeMetaBaseline' AND con.contype IN ('p', 'u') GROUP BY con.oid, con.contype) con), '[]'::json)
  ) AS evidence`)
  return row.evidence
}

test.before(async () => {
  await client.connect()
  await query('BEGIN READ ONLY')
  const { rows: [session] } = await query("SELECT current_database() AS database, current_user AS principal, current_setting('transaction_read_only', true) AS read_only, host(inet_server_addr()) AS server_address, inet_server_port() AS server_port")
  await query('COMMIT')
  const identity = verifyLocalDockerSessionIdentity({ dockerEvidence: evidence, expectedTarget: target, serverSession: { serverAddress: session.server_address, serverPort: session.server_port } })
  assert.equal(identity.verified, true, identity.errors.join('; '))
  assert.equal(session.database, target.database)
  assert.equal(session.read_only, 'on')
  assert.ok(session.principal)
  assert.equal(await userObjectCount(), 0, 'a execução requer banco test vazio antes de DDL')
})

test.after(async () => {
  try {
    if (owned.has('legacy')) await query('DROP TABLE IF EXISTS public."SequelizeMeta"')
    if (owned.has('partial')) await query('DROP TABLE IF EXISTS public._baseline_partial_fixture_probe')
    if (owned.has('baseline')) await query('DROP TABLE IF EXISTS public._baseline_fixture_probe')
    if (owned.has('metadata')) {
      await query('DROP TABLE IF EXISTS baseline_meta."BaselineFoundation"')
      await query('DROP TABLE IF EXISTS baseline_meta."SequelizeMetaBaseline"')
      await query('DROP SCHEMA IF EXISTS baseline_meta')
    }
    assert.equal(await userObjectCount(), 0, 'cleanup deve remover somente recursos criados nesta execução')
  } finally { await client.end() }
})

test('T020/T021: preflight real autoriza somente o destino test vazio e bootstrap não recria database existente', () => {
  const preflight = runDatabasePreflight({ environment, authorizationConfig, databaseState: { exists: true, isEmpty: true, identity: target } })
  assert.equal(preflight.blocked, false)
  const testBootstrap = authorizeProtectedDatabaseBootstrap({ environment, authorizationConfig, effectiveIdentity: target, databaseState: { exists: true } })
  assert.equal(testBootstrap.blocked, true)
  assert.match(testBootstrap.errors.join('\n'), /development-rebuild/)
  const developmentTarget = { environment: 'development', host: 'postgres-rebuild', port: 5432, database: 'alvesglass_rebuild', profile: 'development-rebuild' }
  const developmentEnvironment = { ...environment, NODE_ENV: 'development', PERSISTENCE_PROFILE: 'development-rebuild', PERSISTENCE_INSTANCE_HOST: developmentTarget.host, PERSISTENCE_INSTANCE_PROFILE: 'development-rebuild', BASELINE_DB_HOST: developmentTarget.host, BASELINE_DB_DATABASE: developmentTarget.database }
  const existing = authorizeProtectedDatabaseBootstrap({ environment: developmentEnvironment, authorizationConfig: { ...authorizationConfig, allowlist: [developmentTarget] }, effectiveIdentity: developmentTarget, databaseState: { exists: true } })
  assert.equal(existing.blocked, true)
  assert.match(existing.errors.join('\n'), /não recria|existente/)
  const original = runDatabasePreflight({ environment, authorizationConfig, databaseState: { exists: true, isEmpty: true, identity: authorizationConfig.denylist[0] } })
  assert.equal(original.blocked, true)
})

test('T030/T031: baseline canônico mínimo produz status already-current autenticado e somente leitura', async () => {
  await execute('./node_modules/.bin/sequelize-cli', ['db:migrate', '--config', 'src/database/baseline/config.cjs', '--env', 'test', '--migrations-path', 'src/database/baseline', '--to', canonicalMigration], { cwd: process.cwd(), env: environment })
  owned.add('metadata'); owned.add('canonical')
  const objectsBeforeStatus = await userObjectCount()
  const status = await runStatusBaseline({ environment, dockerEvidence: evidence })
  assert.equal(status.blocked, false, JSON.stringify(status))
  assert.equal(status.state, 'already-current')
  assert.equal(status.details.observation.details.physicalInstance.source, 'local-docker-session-verification')
  assert.equal(await userObjectCount(), objectsBeforeStatus, 'status não pode criar DDL nem alterar schema')
})

test('T022/T023: sequelize-cli aplica fixture canônica e metadata qualificada permanece isolada do histórico legado', async () => {
  const { stderr } = await execute('./node_modules/.bin/sequelize-cli', ['db:migrate', '--config', 'src/database/baseline/config.cjs', '--env', 'test', '--migrations-path', 'tests/support/database/baseline-migrations', '--to', migration], { cwd: process.cwd(), env: environment })
  assert.equal(stderr.includes('ERROR'), false)
  owned.add('metadata'); owned.add('baseline')
  const metadata = await observeMetadata()
  const validation = await validateBaselineMetadata({
    cliExecution: { stage: 'baseline-cli-runner', state: 'validated', blocked: false, details: { metadataRelation: 'baseline_meta.SequelizeMetaBaseline' } },
    metadataObserver: { observeMetadata: async () => metadata },
  })
  assert.equal(validation.blocked, false)
  const objectsBeforeReruns = await userObjectCount()
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await execute('./node_modules/.bin/sequelize-cli', ['db:migrate', '--config', 'src/database/baseline/config.cjs', '--env', 'test', '--migrations-path', 'tests/support/database/baseline-migrations', '--to', migration], { cwd: process.cwd(), env: environment })
  }
  assert.equal(await userObjectCount(), objectsBeforeReruns, 'reexecuções registradas não podem criar DDL adicional')
  const recorded = diagnoseMigrationRecovery({
    metadataValidation: { stage: 'metadata-validator', state: 'validated', blocked: false, details: { metadataRelation: 'baseline_meta.SequelizeMetaBaseline' } },
    recoveryEvidence: { resolution: { relation: 'baseline_meta.SequelizeMetaBaseline', qualified: true, searchPathUsed: false }, metadata: { condition: 'valid' }, canonicalMigrations: [migration], observedMigrations: [{ name: migration, metadataRecorded: true, schemaState: 'consistent' }], legacyHistory: { observed: false } },
    requestedMigrationName: migration,
  })
  assert.equal(recorded.state, 'migration-already-recorded')
  await query('CREATE TABLE public."SequelizeMeta" (name text PRIMARY KEY)')
  await query('INSERT INTO public."SequelizeMeta" (name) VALUES ($1)', ['20261110000000-create-legacy-fixture.cjs'])
  owned.add('legacy')
  const { rows: [isolated] } = await query("SELECT to_regclass('baseline_meta.\"SequelizeMetaBaseline\"') IS NOT NULL AS baseline, to_regclass('public.\"SequelizeMeta\"') IS NOT NULL AS legacy")
  assert.deepEqual(isolated, { baseline: true, legacy: true })
})

test('T024/T025: migration parcial e histórico legado exigem recovery manual, sem reaplicação automática', async () => {
  await assert.rejects(() => execute('./node_modules/.bin/sequelize-cli', ['db:migrate', '--config', 'src/database/baseline/config.cjs', '--env', 'test', '--migrations-path', 'tests/support/database/baseline-migrations', '--to', partialMigration], { cwd: process.cwd(), env: environment }))
  const { rows: [partialTable] } = await query("SELECT to_regclass('public._baseline_partial_fixture_probe') IS NOT NULL AS exists")
  assert.equal(partialTable.exists, true)
  owned.add('partial')
  const partial = diagnoseMigrationRecovery({
    metadataValidation: { stage: 'metadata-validator', state: 'validated', blocked: false, details: { metadataRelation: 'baseline_meta.SequelizeMetaBaseline' } },
    recoveryEvidence: { resolution: { relation: 'baseline_meta.SequelizeMetaBaseline', qualified: true, searchPathUsed: false }, metadata: { condition: 'valid' }, canonicalMigrations: [migration, partialMigration], observedMigrations: [{ name: migration, metadataRecorded: true, schemaState: 'consistent' }, { name: partialMigration, metadataRecorded: false, schemaState: 'partial' }], legacyHistory: { observed: false } },
  })
  assert.equal(partial.state, 'recovery-required')
  const legacy = diagnoseMigrationRecovery({
    metadataValidation: { stage: 'metadata-validator', state: 'validated', blocked: false, details: { metadataRelation: 'baseline_meta.SequelizeMetaBaseline' } },
    recoveryEvidence: { resolution: { relation: 'baseline_meta.SequelizeMetaBaseline', qualified: true, searchPathUsed: false }, metadata: { condition: 'valid' }, canonicalMigrations: [migration], observedMigrations: [{ name: migration, metadataRecorded: true, schemaState: 'consistent' }], legacyHistory: { observed: true, inventoryProvided: false, strategyApproved: false } },
  })
  assert.equal(legacy.state, 'recovery-required')
})