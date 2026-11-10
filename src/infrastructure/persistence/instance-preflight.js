import { loadPersistenceConfig } from '../config/persistence-config.js'
import { authorizeTargetIdentity, identitiesMatchExactly, normalizeIdentity } from './target-identity.js'
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

function buildDeclaredInstanceIdentity(config) {
  return {
    environment: config.NODE_ENV,
    host: config.PERSISTENCE_INSTANCE_HOST,
    port: config.PERSISTENCE_INSTANCE_PORT,
    database: config.BASELINE_DB_DATABASE,
    profile: config.PERSISTENCE_INSTANCE_PROFILE,
  }
}

/**
 * Executa o preflight declarativo da instância sem abrir conexão administrativa. A autorização é
 * recalculada a partir da configuração e das listas recebidas, sem aceitar flags externas como
 * evidência de segurança.
 *
 * @param {{ environment?: Record<string, unknown>, authorizationConfig?: object, effectiveIdentity?: object }} input Dados declarativos, listas não versionadas e identidade efetiva obtida por adaptador futuro.
 * @returns {object} Resultado padronizado de `instance-validated` ou `blocked`.
 */
export function runInstancePreflight(input = {}) {
  const configuration = loadPersistenceConfig(input.environment ?? {}, {
    requiresConnectionCredentials: false,
  })

  if (!configuration.valid) {
    return createBlockedResult('instance-preflight', configuration.errors, {
      configuration: configuration.config,
    }, configuration.warnings)
  }

  const config = configuration.config
  if (config.PERSISTENCE_PROFILE !== 'development-rebuild') {
    return createBlockedResult('instance-preflight', [
      'Preflight de instância administrativa aceita somente o perfil development-rebuild',
    ], {
      requestedProfile: config.PERSISTENCE_PROFILE,
    }, configuration.warnings)
  }

  const declaredInstance = buildDeclaredInstanceIdentity(config)
  const declaredTarget = buildDeclaredTargetIdentity(config)
  if (
    declaredInstance.host !== declaredTarget.host ||
    declaredInstance.port !== declaredTarget.port ||
    declaredInstance.profile !== declaredTarget.profile
  ) {
    return createBlockedResult('instance-preflight', [
      'A identidade declarada da instância deve corresponder a host, porta e perfil do destino autorizado',
    ], {
      declaredInstance,
      declaredTarget,
    }, configuration.warnings)
  }

  const effectiveIdentity = normalizeIdentity(input.effectiveIdentity)
  if (!effectiveIdentity.valid) {
    return createBlockedResult('instance-preflight', effectiveIdentity.errors.map(error => (
      `Identidade efetiva da instância: ${error}`
    )), {
      declaredInstance,
      declaredTarget,
    }, configuration.warnings)
  }

  const identityComparison = identitiesMatchExactly(declaredTarget, effectiveIdentity.identity)
  if (!identityComparison.matches) {
    return createBlockedResult('instance-preflight', [
      'A identidade efetiva da instância diverge integralmente do destino declarado',
      ...identityComparison.errors,
    ], {
      declaredInstance,
      declaredTarget,
      effectiveIdentity: effectiveIdentity.identity,
    }, configuration.warnings)
  }

  const authorization = authorizeTargetIdentity(effectiveIdentity.identity, {
    allowlist: input.authorizationConfig?.allowlist,
    denylist: input.authorizationConfig?.denylist,
    protectedOriginalReference: config.PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE,
  })

  if (!authorization.authorized) {
    return createBlockedResult('instance-preflight', authorization.errors, {
      declaredInstance,
      declaredTarget,
    }, configuration.warnings)
  }

  return createSuccessResult('instance-preflight', 'instance-validated', {
    profile: config.PERSISTENCE_PROFILE,
    instance: declaredInstance,
    target: effectiveIdentity.identity,
    matchedDestination: authorization.matchedDestination,
  }, configuration.warnings)
}