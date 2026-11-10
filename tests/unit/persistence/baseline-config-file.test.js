import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const configPath = path.resolve(projectRoot, 'src/database/baseline/config.cjs')
const canonicalMigrationsPath = path.resolve(projectRoot, 'src/database/baseline')
const legacyMigrationsPath = path.resolve(projectRoot, 'src/database/migrations')

function loadConfig(environment) {
  const output = execFileSync(process.execPath, ['-e', [
    `const config = require(${JSON.stringify(configPath)})`,
    'process.stdout.write(JSON.stringify(config))',
  ].join(';')], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8',
  })

  return JSON.parse(output)
}

const environment = Object.freeze({
  BASELINE_DB_HOST: 'synthetic-postgres',
  BASELINE_DB_PORT: '55432',
  BASELINE_DB_USERNAME: 'synthetic-user',
  BASELINE_DB_PASSWORD: 'synthetic-password',
  BASELINE_DB_DATABASE: 'synthetic-baseline',
})

test('T026 materializa config.cjs exclusivo e passivo para os únicos perfis de baseline autorizados', () => {
  assert.equal(fs.statSync(configPath).isFile(), true)

  const config = loadConfig(environment)
  assert.deepEqual(Object.keys(config).sort(), ['development-rebuild', 'test'])

  for (const profile of Object.values(config)) {
    assert.equal(profile.dialect, 'postgres')
    assert.equal(profile.host, environment.BASELINE_DB_HOST)
    assert.equal(profile.port, environment.BASELINE_DB_PORT)
    assert.equal(profile.username, environment.BASELINE_DB_USERNAME)
    assert.equal(profile.password, environment.BASELINE_DB_PASSWORD)
    assert.equal(profile.database, environment.BASELINE_DB_DATABASE)
    assert.equal(profile.logging, false)
    assert.equal(profile.migrationStorage, 'sequelize')
    assert.equal(profile.migrationStorageTableName, 'SequelizeMetaBaseline')
    assert.equal(profile.migrationStorageTableSchema, 'baseline_meta')
    assert.equal(Object.hasOwn(profile, 'searchPath'), false)
    assert.equal(Object.hasOwn(profile, 'search_path'), false)
  }
})

test('T026 não fornece destino silencioso quando variáveis de conexão do baseline estão ausentes', () => {
  const config = loadConfig({
    BASELINE_DB_HOST: '',
    BASELINE_DB_PORT: '',
    BASELINE_DB_USERNAME: '',
    BASELINE_DB_PASSWORD: '',
    BASELINE_DB_DATABASE: '',
  })

  for (const profile of Object.values(config)) {
    assert.equal(profile.host, '')
    assert.equal(profile.port, '')
    assert.equal(profile.username, '')
    assert.equal(profile.password, '')
    assert.equal(profile.database, '')
  }
})

test('T026 preserva caminho canônico técnico, manifesto explícito e sem referência legada', () => {
  assert.equal(fs.statSync(canonicalMigrationsPath).isDirectory(), true)
  assert.equal(fs.statSync(legacyMigrationsPath).isDirectory(), true)
  assert.equal(fs.statSync(path.resolve(canonicalMigrationsPath, '20261110000000-create-baseline-foundation.cjs')).isFile(), true)
  assert.equal(fs.statSync(path.resolve(canonicalMigrationsPath, 'schema-manifest.json')).isFile(), true)

  const source = fs.readFileSync(configPath, 'utf8')
  assert.doesNotMatch(source, /require\(['"]dotenv['"]\)|from\s+['"]dotenv['"]|require\(['"]pg['"]\)|from\s+['"]pg['"]|src\/database\/migrations|postgres:|postgresql:/i)
  assert.doesNotMatch(source, /createConnection|authenticate|new Sequelize/)
})