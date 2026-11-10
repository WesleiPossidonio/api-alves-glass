import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { createBaselineCliConfig } from '../../../src/infrastructure/persistence/baseline-cli-config.js'
import { runBaselineCli } from '../../../src/infrastructure/persistence/baseline-cli-runner.js'
import { getCanonicalBaselineMigrationsPath } from '../../../src/infrastructure/persistence/migrations-path.js'

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
      if (directorySet.has(normalized)) return { isDirectory: () => true, isFile: () => false }
      if ([...filesByDirectory.entries()].some(([directory, entries]) => entries.some(entry => path.resolve(directory, entry) === normalized))) {
        return { isDirectory: () => false, isFile: () => true }
      }
      throw new Error('not found')
    },
    readdirSync(candidate) {
      return (filesByDirectory.get(path.resolve(candidate)) ?? []).map(name => ({ name, isFile: () => true }))
    },
  }
}

const projectRoot = '/synthetic/project'
const canonicalPath = getCanonicalBaselineMigrationsPath(projectRoot)
const configPath = path.resolve(projectRoot, 'src/database/baseline/config.cjs')
const readyFilesystem = createFilesystem({
  directories: [canonicalPath, path.dirname(configPath)],
  files: { [canonicalPath]: ['20261109000000-initial-baseline.cjs', 'config.cjs'] },
})

function createValidatedConfiguration(overrides = {}) {
  const result = createBaselineCliConfig({
    projectRoot,
    profile: 'test',
    migrationsPath: canonicalPath,
    filesystem: readyFilesystem,
  })
  return {
    ...result,
    details: { ...result.details, ...overrides },
  }
}

test('T027 executa somente sequelize-cli e argumentos canônicos por executor injetado', async () => {
  const calls = []
  const result = await runBaselineCli({
    cliConfiguration: createValidatedConfiguration(),
    filesystem: readyFilesystem,
    processExecutor: {
      async run(command, argumentsList, options) {
        calls.push({ command, argumentsList, options })
        return { exitCode: 0 }
      },
    },
  })

  assert.equal(result.blocked, false)
  assert.equal(result.state, 'validated')
  assert.deepEqual(calls, [{
    command: 'sequelize-cli',
    argumentsList: [
      'db:migrate', '--config', configPath, '--env', 'test', '--migrations-path', canonicalPath,
    ],
    options: { cwd: projectRoot, shell: false, stdio: 'pipe' },
  }])
})

test('T027 bloqueia configuração ausente, bloqueada ou sem executor antes de qualquer processo', async () => {
  let calls = 0
  const processExecutor = { async run() { calls += 1; return { exitCode: 0 } } }

  for (const cliConfiguration of [undefined, { stage: 'baseline-cli-config', state: 'blocked', blocked: true, details: {} }]) {
    const result = await runBaselineCli({ cliConfiguration, filesystem: readyFilesystem, processExecutor })
    assert.equal(result.blocked, true)
  }

  const withoutExecutor = await runBaselineCli({ cliConfiguration: createValidatedConfiguration(), filesystem: readyFilesystem })
  assert.equal(withoutExecutor.blocked, true)
  assert.equal(calls, 0)
})

test('T027 bloqueia caminho inválido, diretório sem migrations e migrations legadas sem chamar processo', async () => {
  let calls = 0
  const processExecutor = { async run() { calls += 1; return { exitCode: 0 } } }
  const cases = [
    {
      configuration: createValidatedConfiguration({ migrationsPath: path.resolve(projectRoot, 'src/database/migrations') }),
      filesystem: readyFilesystem,
    },
    {
      configuration: createBaselineCliConfig({
        projectRoot,
        profile: 'test',
        migrationsPath: canonicalPath,
        filesystem: createFilesystem({ directories: [canonicalPath, path.dirname(configPath)], files: { [canonicalPath]: ['.gitkeep', 'config.cjs'] } }),
      }),
      filesystem: createFilesystem({ directories: [canonicalPath, path.dirname(configPath)], files: { [canonicalPath]: ['.gitkeep', 'config.cjs'] } }),
    },
  ]

  for (const current of cases) {
    const result = await runBaselineCli({
      cliConfiguration: current.configuration,
      filesystem: current.filesystem,
      processExecutor,
    })
    assert.equal(result.blocked, true)
  }
  assert.equal(calls, 0)
})

test('T027 rejeita .sequelizerc, flags, autorização ou identidade fornecidas pelo chamador', async () => {
  let calls = 0
  const processExecutor = { async run() { calls += 1; return { exitCode: 0 } } }
  const configuration = createValidatedConfiguration({
    arguments: ['db:migrate', '--config', configPath, '--env', 'test', '--migrations-path', canonicalPath, '--use-sequelizerc'],
  })

  const configurationResult = await runBaselineCli({ cliConfiguration: configuration, filesystem: readyFilesystem, processExecutor })
  assert.equal(configurationResult.blocked, true)

  for (const field of ['arguments', 'authorizationConfig', 'effectiveIdentity', 'bypass']) {
    const result = await runBaselineCli({
      cliConfiguration: createValidatedConfiguration(),
      filesystem: readyFilesystem,
      processExecutor,
      [field]: field === 'arguments' ? ['db:drop'] : {},
    })
    assert.equal(result.blocked, true)
    assert.match(result.errors.join('\n'), /não permitido/)
  }
  assert.equal(calls, 0)
})

test('T027 bloqueia falha do processo e redige credenciais de diagnósticos', async () => {
  const result = await runBaselineCli({
    cliConfiguration: createValidatedConfiguration(),
    filesystem: readyFilesystem,
    processExecutor: {
      async run() {
        throw new Error('password=super-secret postgresql://runner:super-secret@postgres-test:5432/alvesglass_test')
      },
    },
  })

  assert.equal(result.blocked, true)
  assert.equal(result.errors.join('\n').includes('super-secret'), false)
  assert.match(result.errors.join('\n'), /\[REDACTED\]|\[DATABASE_URL_REDACTED\]/)
})

test('T027 bloqueia código de saída não zero e importação não inicia processo', async () => {
  const failure = await runBaselineCli({
    cliConfiguration: createValidatedConfiguration(),
    filesystem: readyFilesystem,
    processExecutor: { async run() { return { exitCode: 1 } } },
  })
  assert.equal(failure.blocked, true)
  assert.match(failure.errors.join('\n'), /retornou falha/)

  const module = await import('../../../src/infrastructure/persistence/baseline-cli-runner.js')
  assert.equal(typeof module.runBaselineCli, 'function')
})