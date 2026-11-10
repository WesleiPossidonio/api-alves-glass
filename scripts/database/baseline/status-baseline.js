import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAuthenticatedPostgresStatusObserver } from '../../../src/infrastructure/persistence/postgres-status-observer.js'
import { createPostgresAuthenticatedReadOnlyExecutor } from '../../../src/infrastructure/persistence/postgres-authenticated-read-only-executor.js'
import { rebuildBaseline } from '../../../src/infrastructure/persistence/baseline-rebuild.js'
import { createBlockedResult } from '../../../src/infrastructure/persistence/operation-result.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const canonicalMigrationsDirectory = path.resolve(projectRoot, 'src/database/baseline')
const schemaManifestPath = path.resolve(canonicalMigrationsDirectory, 'schema-manifest.json')

function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[DATABASE_URL_REDACTED]')
    .replace(/\b(password|pwd|BASELINE_DB_PASSWORD)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(username|user|BASELINE_DB_USERNAME)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
}

function readJsonFile(filename, label) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { valid: true, value: parsed }
      : { valid: false, error: `${label} deve conter um objeto JSON` }
  } catch {
    return { valid: false, error: `${label} ausente ou inválido` }
  }
}

function listCanonicalMigrations() {
  try {
    return fs.readdirSync(canonicalMigrationsDirectory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name !== 'config.cjs' && entry.name !== '.gitkeep')
      .filter(entry => /\.(cjs|js|cts|ts)$/.test(entry.name))
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

function loadSchemaManifest(canonicalMigrations) {
  const manifest = readJsonFile(schemaManifestPath, 'Manifesto canônico de schema')
  if (!manifest.valid || manifest.value.version !== 1 || !Array.isArray(manifest.value.migrations)) {
    return { valid: false, error: 'Manifesto canônico de schema ausente ou inválido' }
  }
  const manifestNames = manifest.value.migrations.map(migration => migration?.name).sort()
  if (manifestNames.length !== canonicalMigrations.length || manifestNames.some((name, index) => name !== canonicalMigrations[index])) {
    return { valid: false, error: 'Manifesto canônico deve cobrir exatamente as migrations do diretório baseline' }
  }
  return { valid: true, value: manifest.value }
}

/**
 * Executa exclusivamente `status` no processo já posicionado na rede Docker de teste. A evidência
 * Docker é recebida do launcher confiável no host; este script não acessa Docker, CLI ou DDL.
 *
 * @param {{ environment?: Record<string, string|undefined>, dockerEvidence?: object }} input Ambiente local e inspeção Docker pré-coletada.
 * @returns {Promise<object>} Resultado `already-current`, `recovery-required` ou `blocked`.
 */
export async function runStatusBaseline(input = {}) {
  const environment = input.environment ?? process.env
  const identityPath = environment.BASELINE_IDENTITY_CONFIG_PATH
  const authorization = readJsonFile(identityPath, 'Arquivo de identidade operacional')
  if (!authorization.valid) return createBlockedResult('status-baseline', [authorization.error])

  const dockerEvidence = input.dockerEvidence ?? (() => {
    try { return JSON.parse(environment.BASELINE_LOCAL_DOCKER_EVIDENCE ?? '') } catch { return null }
  })()
  if (!dockerEvidence || typeof dockerEvidence !== 'object' || Array.isArray(dockerEvidence)) {
    return createBlockedResult('status-baseline', ['Evidência Docker local confiável é obrigatória para status no profile test'])
  }

  const canonicalMigrations = listCanonicalMigrations()
  if (canonicalMigrations.length === 0) {
    return createBlockedResult('status-baseline', ['Não há migrations canônicas de produção para observar; status permanece bloqueado sem conectar'])
  }
  const schemaManifest = loadSchemaManifest(canonicalMigrations)
  if (!schemaManifest.valid) return createBlockedResult('status-baseline', [schemaManifest.error])
  if (environment.PERSISTENCE_PROFILE !== 'test' || environment.NODE_ENV !== 'test' || environment.BASELINE_DB_HOST !== 'postgres-test' || String(environment.BASELINE_DB_PORT) !== '5432') {
    return createBlockedResult('status-baseline', ['Status local aceita exclusivamente profile test dentro da rede Docker em postgres-test:5432'])
  }

  const target = Object.freeze({ environment: 'test', host: 'postgres-test', port: 5432, database: environment.BASELINE_DB_DATABASE, profile: 'test' })
  const executor = createPostgresAuthenticatedReadOnlyExecutor({
    connectionConfig: Object.freeze({ host: 'postgres-test', port: 5432, database: environment.BASELINE_DB_DATABASE, user: environment.BASELINE_DB_USERNAME, password: environment.BASELINE_DB_PASSWORD }),
    authorizationConfig: { ...authorization.value, protectedOriginalReference: environment.PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE },
    localDockerEvidence: dockerEvidence,
    schemaManifest: schemaManifest.value,
  })
  const observer = createAuthenticatedPostgresStatusObserver({ readOnlyExecutor: executor })
  return rebuildBaseline({
    profile: 'test',
    config: { PERSISTENCE_PROFILE: 'test' },
    mode: 'status',
    statusObserver: observer,
    declaredTarget: target,
    authorizationConfig: { ...authorization.value, protectedOriginalReference: environment.PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE },
    canonicalMigrations,
  })
}

async function main() {
  dotenv.config({ path: process.env.BASELINE_STATUS_ENV_FILE ?? path.resolve(projectRoot, '.env.persistence-api-test') })
  try {
    const result = await runStatusBaseline()
    console.log(JSON.stringify(result))
    if (result.blocked) process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify(createBlockedResult('status-baseline', [`Status local falhou: ${sanitizeDiagnostic(error instanceof Error ? error.message : 'erro desconhecido')}`])))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()