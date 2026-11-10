import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { createBaselineCliConfig } from '../../../src/infrastructure/persistence/baseline-cli-config.js'
import { BASELINE_METADATA_CONFIG, BASELINE_METADATA_RELATION, createBaselineMetadataConfig, validateBaselineMetadataConfig } from '../../../src/infrastructure/persistence/metadata-config.js'
import { getCanonicalBaselineMigrationsPath, validateBaselineMigrationsPath } from '../../../src/infrastructure/persistence/migrations-path.js'

function createFilesystem({ directories = [], files = {} } = {}) {
  const directorySet = new Set(directories.map(candidate => path.resolve(candidate)))
  const filesByDirectory = new Map(Object.entries(files).map(([directory, entries]) => [path.resolve(directory), entries]))

  return {
    existsSync(candidate) {
      const normalized = path.resolve(candidate)
      return directorySet.has(normalized) || [...filesByDirectory.entries()].some(([directory, entries]) => (
        entries.some(entry => path.resolve(directory, entry) === normalized)
      ))
    },
    statSync(candidate) {
      const normalized = path.resolve(candidate)
      if (directorySet.has(normalized)) {
        return { isDirectory: () => true, isFile: () => false }
      }
      if ([...filesByDirectory.entries()].some(([directory, entries]) => entries.some(entry => path.resolve(directory, entry) === normalized))) {
        return { isDirectory: () => false, isFile: () => true }
      }
      throw new Error('not found')
    },
    readdirSync(candidate) {
      return (filesByDirectory.get(path.resolve(candidate)) ?? []).map(name => ({
        name,
        isFile: () => true,
      }))
    },
  }
}

const projectRoot = '/synthetic/project'
const canonicalPath = getCanonicalBaselineMigrationsPath(projectRoot)
const configPath = path.resolve(projectRoot, 'src/database/baseline/config.cjs')
const readyFilesystem = createFilesystem({
  directories: [canonicalPath, path.dirname(configPath)],
  files: {
    [canonicalPath]: ['20261109000000-initial-baseline.cjs', 'config.cjs'],
  },
})

test('T013 aceita somente caminho canônico absoluto e separa configuração de prontidão', () => {
  const configuredButNotReady = validateBaselineMigrationsPath({
    projectRoot,
    configuredPath: canonicalPath,
    filesystem: createFilesystem({ directories: [canonicalPath], files: { [canonicalPath]: ['.gitkeep'] } }),
  })
  assert.equal(configuredButNotReady.configurationValid, true)
  assert.equal(configuredButNotReady.operationallyReady, false)
  assert.equal(configuredButNotReady.valid, false)

  const onlyConfigFile = validateBaselineMigrationsPath({
    projectRoot,
    configuredPath: canonicalPath,
    filesystem: createFilesystem({ directories: [canonicalPath], files: { [canonicalPath]: ['config.cjs'] } }),
  })
  assert.equal(onlyConfigFile.operationallyReady, false)
  assert.equal(onlyConfigFile.migrations.includes('config.cjs'), false)

  const ready = validateBaselineMigrationsPath({ projectRoot, configuredPath: canonicalPath, filesystem: readyFilesystem })
  assert.equal(ready.valid, true)

  const legacy = validateBaselineMigrationsPath({
    projectRoot,
    configuredPath: path.resolve(projectRoot, 'src/database/migrations'),
    filesystem: readyFilesystem,
  })
  assert.equal(legacy.valid, false)
  assert.match(legacy.errors.join('\n'), /legado|canônico/)

  const relative = validateBaselineMigrationsPath({ projectRoot, configuredPath: 'src/database/baseline', filesystem: readyFilesystem })
  assert.equal(relative.valid, false)
  assert.match(relative.errors.join('\n'), /absoluto/)

  const external = validateBaselineMigrationsPath({
    projectRoot,
    configuredPath: '/synthetic/external/migrations',
    filesystem: readyFilesystem,
  })
  assert.equal(external.valid, false)
  assert.match(external.errors.join('\n'), /canônico/)

  const fileInsteadOfDirectory = validateBaselineMigrationsPath({
    projectRoot,
    configuredPath: canonicalPath,
    filesystem: createFilesystem({ files: { [path.dirname(canonicalPath)]: ['baseline'] } }),
  })
  assert.equal(fileInsteadOfDirectory.valid, false)
  assert.match(fileInsteadOfDirectory.errors.join('\n'), /diretório/)
})

test('T014 constrói somente declaração explícita do sequelize-cli quando T013 está pronta', () => {
  const result = createBaselineCliConfig({
    projectRoot,
    profile: 'development-rebuild',
    migrationsPath: canonicalPath,
    filesystem: readyFilesystem,
  })
  assert.equal(result.state, 'validated')
  assert.deepEqual(result.details.arguments, [
    'db:migrate',
    '--config', configPath,
    '--env', 'development-rebuild',
    '--migrations-path', canonicalPath,
  ])
  assert.equal(result.details.arguments.includes(path.resolve(projectRoot, 'src/database/migrations')), false)
  assert.equal(result.details.metadata.migrationStorageTableSchema, 'baseline_meta')

  const missingConfig = createBaselineCliConfig({
    projectRoot,
    profile: 'development-rebuild',
    migrationsPath: canonicalPath,
    filesystem: createFilesystem({
      directories: [canonicalPath],
      files: { [canonicalPath]: ['20261109000000-initial-baseline.cjs'] },
    }),
  })
  assert.equal(missingConfig.blocked, true)
  assert.match(missingConfig.errors.join('\n'), /--config exclusivo.*não existe/)

  const blocked = createBaselineCliConfig({ projectRoot, profile: 'inventory-readonly', migrationsPath: canonicalPath, filesystem: readyFilesystem })
  assert.equal(blocked.blocked, true)
  assert.match(blocked.errors.join('\n'), /somente os perfis/)
})

test('T015 fixa metadata exclusiva e rejeita public ou search_path', () => {
  assert.deepEqual(createBaselineMetadataConfig(), BASELINE_METADATA_CONFIG)
  assert.equal(validateBaselineMetadataConfig(createBaselineMetadataConfig()).valid, true)
  assert.equal(BASELINE_METADATA_RELATION, 'baseline_meta.SequelizeMetaBaseline')
  assert.equal(validateBaselineMetadataConfig({
    migrationStorage: 'sequelize',
    migrationStorageTableName: 'SequelizeMeta',
    migrationStorageTableSchema: 'public',
  }).valid, false)
  assert.equal(validateBaselineMetadataConfig({ ...BASELINE_METADATA_CONFIG, searchPath: 'public' }).valid, false)
  assert.equal(validateBaselineMetadataConfig({ ...BASELINE_METADATA_CONFIG, search_path: 'baseline_meta' }).valid, false)
})