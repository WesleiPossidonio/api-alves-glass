import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { rebuildBaseline } from '../../../src/infrastructure/persistence/baseline-rebuild.js'
import { createAuthenticatedPostgresStatusObserver } from '../../../src/infrastructure/persistence/postgres-status-observer.js'

const target = Object.freeze({ environment: 'test', host: 'postgres-test', port: 5432, database: 'alvesglass_test', profile: 'test' })
const config = Object.freeze({ PERSISTENCE_PROFILE: 'test' })
const databasePreflight = Object.freeze({
  stage: 'database-preflight', state: 'validated', blocked: false,
  details: Object.freeze({ target, databaseState: Object.freeze({ exists: true, isEmpty: true }) }),
})
const metadataValidated = Object.freeze({
  stage: 'metadata-validator', state: 'validated', blocked: false,
  details: Object.freeze({ metadataRelation: 'baseline_meta.SequelizeMetaBaseline' }),
})
const metadataBlocked = Object.freeze({
  stage: 'metadata-validator', state: 'blocked', blocked: true,
  details: Object.freeze({ metadataRelation: 'baseline_meta.SequelizeMetaBaseline' }),
})
const migrationName = '20261110000000-initial-baseline.cjs'

function recoveryEvidence(overrides = {}) {
  return {
    metadataValidation: metadataValidated,
    resolution: { relation: 'baseline_meta.SequelizeMetaBaseline', qualified: true, searchPathUsed: false },
    metadata: { condition: 'valid' },
    canonicalMigrations: [migrationName],
    observedMigrations: [{ name: migrationName, metadataRecorded: true, schemaState: 'consistent' }],
    legacyHistory: { observed: false },
    ...overrides,
  }
}

function input(overrides = {}) {
  return {
    profile: 'test', config, mode: 'status', ...overrides,
  }
}

function statusObserver(snapshotOverrides = {}, calls = []) {
  return createAuthenticatedPostgresStatusObserver({
    readOnlyExecutor: {
      async observeBaselineState() {
        calls.push('observe')
        return {
          authentication: { authenticated: true, readOnly: true, principal: 'reader' },
          connectedEndpoint: { verified: true, host: target.host, port: target.port },
          physicalInstance: { verified: true, source: 'approved-endpoint-attestation', fingerprint: 'test-instance' },
          observedIdentity: target,
          databaseState: { exists: true, isEmpty: false },
          serverSession: { currentDatabase: target.database, currentUser: 'reader' },
          metadataEvidence: {
            resolvedRelation: 'baseline_meta.SequelizeMetaBaseline', resolution: { qualified: true, searchPathUsed: false },
            schema: { name: 'baseline_meta', exists: true }, table: { schema: 'baseline_meta', name: 'SequelizeMetaBaseline', exists: true },
            nameColumn: { exists: true, nullable: false }, constraints: [{ type: 'PRIMARY KEY', columns: ['name'] }],
            recordedMigrations: [migrationName],
          },
          observedMigrations: [{ name: migrationName, schemaState: 'consistent' }],
          legacyHistory: { observed: false },
          ...snapshotOverrides,
        }
      },
    },
  })
}

const statusAuthorization = Object.freeze({
  allowlist: [target],
  denylist: [{ environment: 'production', host: 'original', port: 5432, database: 'original', profile: 'production', reference: 'original' }],
  protectedOriginalReference: 'original',
})

function statusInput(overrides = {}) {
  return input({
    statusObserver: statusObserver(), declaredTarget: target, authorizationConfig: statusAuthorization,
    canonicalMigrations: [migrationName], ...overrides,
  })
}

test('T030 retorna already-current exclusivamente por observação autenticada, sem T012, CLI ou DDL', async () => {
  const calls = []
  const current = await rebuildBaseline(statusInput({ statusObserver: statusObserver({}, calls) }))
  assert.equal(current.blocked, false)
  assert.equal(current.state, 'already-current')
  assert.deepEqual(calls, ['observe'])
})

test('T030 encadeia CLI controlado, metadata e recovery somente com adaptadores injetados', async () => {
  const projectRoot = '/synthetic/project'
  const migrationsPath = path.resolve(projectRoot, 'src/database/baseline')
  const configPath = path.resolve(projectRoot, 'src/database/baseline/config.cjs')
  const filesystem = {
    existsSync(candidate) { return [migrationsPath, configPath].includes(path.resolve(candidate)) },
    statSync(candidate) {
      const normalized = path.resolve(candidate)
      if (normalized === migrationsPath) return { isDirectory: () => true, isFile: () => false }
      if (normalized === configPath) return { isDirectory: () => false, isFile: () => true }
      throw new Error('not found')
    },
    readdirSync() { return [{ name: '20261110000000-initial-baseline.cjs', isFile: () => true }] },
  }
  const cliConfiguration = {
    stage: 'baseline-cli-config', state: 'validated', blocked: false,
    details: {
      executable: 'sequelize-cli', configPath, environment: 'test', migrationsPath,
      arguments: ['db:migrate', '--config', configPath, '--env', 'test', '--migrations-path', migrationsPath],
      metadata: { migrationStorage: 'sequelize', migrationStorageTableName: 'SequelizeMetaBaseline', migrationStorageTableSchema: 'baseline_meta' },
    },
  }
  const calls = []
  const result = await rebuildBaseline({
    ...input({ mode: 'apply', databasePreflight, recoveryEvidence: recoveryEvidence() }),
    cliConfiguration,
    filesystem,
    processExecutor: { async run(command, argumentsList) { calls.push({ command, argumentsList }); return { exitCode: 0 } } },
    metadataObserver: {
      async observeMetadata() {
        return {
          resolvedRelation: 'baseline_meta.SequelizeMetaBaseline', resolution: { qualified: true, searchPathUsed: false },
          schema: { name: 'baseline_meta', exists: true }, table: { schema: 'baseline_meta', name: 'SequelizeMetaBaseline', exists: true },
          nameColumn: { exists: true, nullable: false }, constraints: [{ type: 'PRIMARY KEY', columns: ['name'] }],
        }
      },
    },
  })
  assert.equal(result.blocked, false)
  assert.equal(result.state, 'rebuild-complete')
  assert.deepEqual(calls, [{ command: 'sequelize-cli', argumentsList: cliConfiguration.details.arguments }])
})

test('T030 encaminha divergência e aplicação parcial exclusivamente para recovery-required', async () => {
  const result = await rebuildBaseline(statusInput({
    statusObserver: statusObserver({
      metadataEvidence: {
        resolvedRelation: 'baseline_meta.SequelizeMetaBaseline', resolution: { qualified: true, searchPathUsed: false },
        schema: { name: 'baseline_meta', exists: true }, table: { schema: 'baseline_meta', name: 'SequelizeMetaBaseline', exists: true },
        nameColumn: { exists: true, nullable: false }, constraints: [{ type: 'PRIMARY KEY', columns: ['name'] }], recordedMigrations: [],
      },
      observedMigrations: [{ name: migrationName, schemaState: 'partial' }],
    }),
  }))
  assert.equal(result.blocked, true)
  assert.equal(result.state, 'recovery-required')
  assert.equal(result.details.recovery.details.automaticRecovery, false)
})

test('T030 bloqueia preflight/evidência ausentes ou inválidos antes de CLI', async () => {
  for (const overrides of [
    { mode: 'apply', databasePreflight: undefined, cliConfiguration: {}, processExecutor: {}, metadataObserver: {}, recoveryEvidence: recoveryEvidence() },
    { mode: 'apply', databasePreflight: { ...databasePreflight, details: { databaseState: { exists: true, isEmpty: false } } }, cliConfiguration: {}, processExecutor: {}, metadataObserver: {}, recoveryEvidence: recoveryEvidence() },
    { mode: 'status', statusObserver: undefined },
    { mode: 'status', statusObserver: statusObserver(), declaredTarget: target, authorizationConfig: statusAuthorization, canonicalMigrations: [migrationName], requestedMigrationName: migrationName },
    { mode: 'status', statusObserver: statusObserver(), declaredTarget: target, authorizationConfig: statusAuthorization, canonicalMigrations: [migrationName], profile: 'development-rebuild' },
  ]) {
    const result = await rebuildBaseline(input(overrides))
    assert.equal(result.blocked, true)
    assert.equal(result.state, 'blocked')
  }
})

test('T030 não transforma status em autorização para apply', async () => {
  const status = await rebuildBaseline(statusInput())
  assert.equal(status.state, 'already-current')

  const apply = await rebuildBaseline(input({
    mode: 'apply', cliConfiguration: {}, processExecutor: {}, metadataObserver: {}, recoveryEvidence: recoveryEvidence(),
  }))
  assert.equal(apply.blocked, true)
  assert.match(apply.errors.join('\n'), /Preflight de database/)
})

test('T030 bloqueia resultado declarativo que tente imitar observação autenticada', async () => {
  const result = await rebuildBaseline(input({
    statusObserver: {
      async observeBaselineStatus() {
        return {
          stage: 'postgres-status-observer', state: 'validated', blocked: false, errors: [], warnings: [],
          details: { metadataValidation: metadataValidated, recoveryEvidence: recoveryEvidence() },
        }
      },
    },
    declaredTarget: target,
    authorizationConfig: statusAuthorization,
    canonicalMigrations: [migrationName],
  }))

  assert.equal(result.blocked, true)
  assert.match(result.errors.join('\n'), /não emitido pela infraestrutura autenticada/)
})

test('T030 rejeita executores/flags externos e importação não inicia operação', async () => {
  const result = await rebuildBaseline({ ...input(), bypass: true })
  assert.equal(result.blocked, true)
  assert.match(result.errors.join('\n'), /não permitido/)

  const module = await import('../../../src/infrastructure/persistence/baseline-rebuild.js')
  assert.equal(typeof module.rebuildBaseline, 'function')
})