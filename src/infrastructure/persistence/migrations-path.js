import fs from 'node:fs'
import path from 'node:path'

export const CANONICAL_BASELINE_MIGRATIONS_SEGMENTS = Object.freeze([
  'src',
  'database',
  'baseline',
])

export const LEGACY_MIGRATIONS_SEGMENTS = Object.freeze([
  'src',
  'database',
  'migrations',
])

function normalizeProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0 || !path.isAbsolute(projectRoot.trim())) {
    return null
  }

  return path.resolve(projectRoot.trim())
}

function normalizeAbsolutePath(candidate) {
  if (typeof candidate !== 'string' || candidate.trim().length === 0 || !path.isAbsolute(candidate.trim())) {
    return null
  }

  return path.resolve(candidate.trim())
}

function isDirectory(filesystem, candidatePath) {
  try {
    return filesystem.statSync(candidatePath).isDirectory()
  } catch {
    return false
  }
}

function listOperationalMigrations(filesystem, canonicalPath) {
  try {
    return filesystem.readdirSync(canonicalPath, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name !== '.gitkeep' && entry.name !== 'config.cjs')
      .filter(entry => /\.(cjs|js|cts|ts)$/.test(entry.name))
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Deriva o único diretório de migrations do baseline a partir da raiz do projeto, sem usar caminho
 * absoluto da máquina atual, `.sequelizerc` ou descoberta de diretórios legados.
 *
 * @param {string} projectRoot Raiz absoluta do repositório fornecida pelo chamador.
 * @returns {string | null} Caminho canônico normalizado ou `null` para raiz inválida.
 */
export function getCanonicalBaselineMigrationsPath(projectRoot) {
  const normalizedProjectRoot = normalizeProjectRoot(projectRoot)
  return normalizedProjectRoot
    ? path.resolve(normalizedProjectRoot, ...CANONICAL_BASELINE_MIGRATIONS_SEGMENTS)
    : null
}

/**
 * Valida o caminho declarativo e informa separadamente se o conjunto está pronto para uso futuro.
 * A função apenas consulta o sistema de arquivos explicitamente injetável; nunca cria diretórios,
 * arquivos, metadata, conexões ou executa migrations.
 *
 * @param {{ configuredPath?: unknown, projectRoot?: unknown, filesystem?: Pick<typeof fs, 'existsSync'|'statSync'|'readdirSync'> }} input Caminho configurado e raiz do projeto.
 * @returns {{ valid: boolean, configurationValid: boolean, operationallyReady: boolean, errors: string[], warnings: string[], configuredPath: string | null, canonicalPath: string | null, migrations: string[] }} Diagnóstico fail-closed.
 */
export function validateBaselineMigrationsPath(input = {}) {
  const filesystem = input.filesystem ?? fs
  const canonicalPath = getCanonicalBaselineMigrationsPath(input.projectRoot)
  const configuredPath = normalizeAbsolutePath(input.configuredPath)
  const errors = []
  const warnings = []

  if (!canonicalPath) {
    errors.push('A raiz do projeto deve ser um caminho absoluto para derivar o diretório canônico de migrations')
  }

  if (!configuredPath) {
    errors.push('BASELINE_MIGRATIONS_PATH deve ser um caminho absoluto não vazio')
  }

  const legacyPath = canonicalPath
    ? path.resolve(canonicalPath, '..', 'migrations')
    : null
  if (configuredPath && legacyPath && configuredPath === legacyPath) {
    errors.push('BASELINE_MIGRATIONS_PATH não pode apontar para o diretório legado de migrations')
  }

  if (configuredPath && canonicalPath && configuredPath !== canonicalPath) {
    errors.push('BASELINE_MIGRATIONS_PATH deve ser exatamente igual ao diretório canônico do baseline')
  }

  if (configuredPath && !filesystem.existsSync(configuredPath)) {
    errors.push('BASELINE_MIGRATIONS_PATH não existe')
  } else if (configuredPath && !isDirectory(filesystem, configuredPath)) {
    errors.push('BASELINE_MIGRATIONS_PATH deve apontar para um diretório')
  }

  const configurationValid = errors.length === 0
  const migrations = configurationValid ? listOperationalMigrations(filesystem, canonicalPath) : []
  if (configurationValid && migrations.length === 0) {
    warnings.push('O diretório canônico está configurado, mas ainda não contém migrations do baseline prontas para execução')
  }

  const operationallyReady = configurationValid && migrations.length > 0
  return Object.freeze({
    valid: operationallyReady,
    configurationValid,
    operationallyReady,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    configuredPath,
    canonicalPath,
    migrations: Object.freeze(migrations),
  })
}