import { loadPersistenceConfig } from '../config/persistence-config.js'
import { authorizeTargetIdentity, normalizeIdentity } from './target-identity.js'
import { createBlockedResult, createSuccessResult } from './operation-result.js'

function buildDeclaredTargetIdentity(config) {
  return {
    environment: config.NODE_ENV,
    host: config.BASELINE_DB_HOST,
    port: config.BASELINE_DB_PORT,
    database: config.BASELINE_DB_DATABASE,
    profile: config.PERSISTENCE_PROFILE,
  }
}

function validateDatabaseEvidence(databaseState, expectedIdentity) {
  const errors = []
  if (!databaseState || typeof databaseState !== 'object') {
    return ['Evidência de estado do database é obrigatória']
  }

  if (typeof databaseState.exists !== 'boolean') {
    errors.push('Evidência de estado deve informar explicitamente se o database existe')
  }

  if (databaseState.exists !== true) {
    errors.push('Preflight do database exige destino existente após bootstrap protegido')
  }

  if (typeof databaseState.isEmpty !== 'boolean') {
    errors.push('Evidência de estado deve informar explicitamente se o database está vazio')
  } else if (databaseState.isEmpty !== true) {
    errors.push('Database existente não está comprovadamente vazio; rebuild inicial não é autorizado')
  }

  const observed = normalizeIdentity(databaseState.identity)
  if (!observed.valid) {
    errors.push(...observed.errors.map(error => `Identidade efetiva observada: ${error}`))
  } else {
    const expected = normalizeIdentity(expectedIdentity)
    if (!expected.valid || JSON.stringify(observed.identity) !== JSON.stringify(expected.identity)) {
      errors.push('Identidade efetiva observada diverge do destino declarado e autorizado')
    }
  }

  return errors
}

/**
 * Valida o destino já existente e comprovadamente vazio antes de qualquer CLI, metadata ou DDL.
 * A inspeção efetiva é uma dependência futura; nesta etapa o módulo exige evidência estruturada e
 * nunca abre conexão por conta própria.
 *
 * @param {{ environment?: Record<string, unknown>, authorizationConfig?: object, databaseState?: object }} input Configuração, listas e evidência injetada.
 * @returns {object} Resultado `validated` ou `blocked`.
 */
export function runDatabasePreflight(input = {}) {
  const configuration = loadPersistenceConfig(input.environment ?? {}, {
    requiresConnectionCredentials: false,
  })
  if (!configuration.valid) {
    return createBlockedResult('database-preflight', configuration.errors, {
      configuration: configuration.config,
    }, configuration.warnings)
  }

  const config = configuration.config
  const declaredTarget = buildDeclaredTargetIdentity(config)
  const authorization = authorizeTargetIdentity(declaredTarget, {
    allowlist: input.authorizationConfig?.allowlist,
    denylist: input.authorizationConfig?.denylist,
    protectedOriginalReference: config.PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE,
  })
  if (!authorization.authorized) {
    return createBlockedResult('database-preflight', authorization.errors, {
      declaredTarget,
    }, configuration.warnings)
  }

  const evidenceErrors = validateDatabaseEvidence(input.databaseState, authorization.identity)
  if (evidenceErrors.length > 0) {
    return createBlockedResult('database-preflight', evidenceErrors, {
      declaredTarget,
      authorizedTarget: authorization.identity,
    }, configuration.warnings)
  }

  return createSuccessResult('database-preflight', 'validated', {
    profile: config.PERSISTENCE_PROFILE,
    target: authorization.identity,
    matchedDestination: authorization.matchedDestination,
    databaseState: {
      exists: true,
      isEmpty: true,
    },
  }, configuration.warnings)
}