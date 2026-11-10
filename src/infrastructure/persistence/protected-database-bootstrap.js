import { runInstancePreflight } from './instance-preflight.js'
import { createBlockedResult, createSuccessResult } from './operation-result.js'

const MAX_POSTGRES_IDENTIFIER_BYTES = 63

/**
 * Valida e delimita um identificador PostgreSQL sem executar SQL. O valor delimitado só pode ser
 * entregue a um executor administrativo futuro após o preflight ser recalculado neste módulo.
 *
 * @param {unknown} identifier Nome de database declarado.
 * @returns {{ valid: boolean, errors: string[], identifier: string | null, quotedIdentifier: string | null }}
 */
export function validatePostgresIdentifier(identifier) {
  const errors = []
  if (typeof identifier !== 'string' || identifier.trim().length === 0) {
    errors.push('Identificador PostgreSQL é obrigatório')
  }

  const normalized = typeof identifier === 'string' ? identifier.trim() : ''
  if (normalized.includes('\u0000')) {
    errors.push('Identificador PostgreSQL não pode conter byte NUL')
  }

  if (Buffer.byteLength(normalized, 'utf8') > MAX_POSTGRES_IDENTIFIER_BYTES) {
    errors.push(`Identificador PostgreSQL não pode exceder ${MAX_POSTGRES_IDENTIFIER_BYTES} bytes UTF-8`)
  }

  return {
    valid: errors.length === 0,
    errors,
    identifier: errors.length === 0 ? normalized : null,
    quotedIdentifier: errors.length === 0 ? `"${normalized.replaceAll('"', '""')}"` : null,
  }
}

function validateDatabaseState(databaseState) {
  if (!databaseState || typeof databaseState !== 'object' || typeof databaseState.exists !== 'boolean') {
    return ['O estado do database deve informar explicitamente se o destino existe']
  }

  return []
}

/**
 * Revalida autorização e prepara uma criação protegida. Não abre conexão nem emite DDL: o estado
 * do destino e o executor administrativo são dependências injetadas para a fase operacional futura.
 *
 * @param {{ environment?: Record<string, unknown>, authorizationConfig?: object, effectiveIdentity?: object, databaseState?: { exists: boolean } }} input Dados declarativos e estado inspecionado futuramente.
 * @returns {object} Resultado `blocked` ou autorização pronta para criação futura.
 */
export function authorizeProtectedDatabaseBootstrap(input = {}) {
  const preflight = runInstancePreflight({
    environment: input.environment,
    authorizationConfig: input.authorizationConfig,
    effectiveIdentity: input.effectiveIdentity,
  })

  if (preflight.blocked) {
    return createBlockedResult('protected-database-bootstrap', preflight.errors, {
      preflight,
    }, preflight.warnings)
  }

  const stateErrors = validateDatabaseState(input.databaseState)
  if (stateErrors.length > 0) {
    return createBlockedResult('protected-database-bootstrap', stateErrors, {
      preflight,
    })
  }

  if (input.databaseState.exists) {
    return createBlockedResult('protected-database-bootstrap', [
      'Database autorizado já existe; bootstrap protegido não recria, substitui ou remove destinos existentes',
    ], {
      preflight,
      databaseState: { exists: true },
    })
  }

  const identifier = validatePostgresIdentifier(preflight.details.target.database)
  if (!identifier.valid) {
    return createBlockedResult('protected-database-bootstrap', identifier.errors, {
      preflight,
    })
  }

  return createSuccessResult('protected-database-bootstrap', 'validated', {
    preflight,
    databaseIdentifier: identifier.identifier,
    quotedDatabaseIdentifier: identifier.quotedIdentifier,
  })
}

/**
 * Executa somente um executor administrativo explicitamente injetado e somente após a autorização
 * ser recalculada no mesmo limite. Não fornece cliente PostgreSQL, SQL bruto nem fallback para
 * `DROP DATABASE`; os testes desta fase usam apenas fakes locais.
 *
 * @param {{ environment?: Record<string, unknown>, authorizationConfig?: object, effectiveIdentity?: object, databaseState?: { exists: boolean } }} input Dados declarativos e estado inspecionado futuramente.
 * @param {{ createDatabase?: (quotedDatabaseIdentifier: string) => Promise<void> }} administrativeExecutor Executor futuro explicitamente fornecido.
 * @returns {Promise<object>} Resultado `database-created` ou `blocked`.
 */
export async function createProtectedDatabase(input = {}, administrativeExecutor) {
  const authorization = authorizeProtectedDatabaseBootstrap(input)
  if (authorization.blocked) {
    return authorization
  }

  if (!administrativeExecutor || typeof administrativeExecutor.createDatabase !== 'function') {
    return createBlockedResult('protected-database-bootstrap', [
      'Executor administrativo explícito é obrigatório para criar database autorizado',
    ], {
      authorization,
    })
  }

  try {
    await administrativeExecutor.createDatabase(authorization.details.quotedDatabaseIdentifier)
    return createSuccessResult('protected-database-bootstrap', 'database-created', {
      databaseIdentifier: authorization.details.databaseIdentifier,
    })
  } catch (error) {
    return createBlockedResult('protected-database-bootstrap', [
      `Executor administrativo falhou ao criar database autorizado: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
    ], {
      databaseIdentifier: authorization.details.databaseIdentifier,
    })
  }
}