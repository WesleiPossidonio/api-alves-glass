import { loadPersistenceConfig } from '../../../src/infrastructure/config/persistence-config.js'
import { runDatabasePreflight } from '../../../src/infrastructure/persistence/database-preflight.js'
import { identitiesMatchExactly, authorizeTargetIdentity } from '../../../src/infrastructure/persistence/target-identity.js'
import { createBlockedResult, createSuccessResult } from '../../../src/infrastructure/persistence/operation-result.js'

const STAGE = 'postgres-test-environment'
const trackers = new WeakMap()

function validateTestIdentity(input) {
  const configuration = loadPersistenceConfig(input.environment ?? {}, { requiresConnectionCredentials: false })
  if (!configuration.valid) {
    return { valid: false, errors: configuration.errors, warnings: configuration.warnings, config: null, target: null }
  }

  const config = configuration.config
  if (config.PERSISTENCE_PROFILE !== 'test' || config.NODE_ENV !== 'test' || config.PERSISTENCE_INSTANCE_PROFILE !== 'test') {
    return {
      valid: false,
      errors: ['O ambiente de teste exige PERSISTENCE_PROFILE, NODE_ENV e PERSISTENCE_INSTANCE_PROFILE exatamente iguais a test'],
      warnings: configuration.warnings,
      config,
      target: null,
    }
  }

  const target = {
    environment: 'test',
    host: config.BASELINE_DB_HOST,
    port: config.BASELINE_DB_PORT,
    database: config.BASELINE_DB_DATABASE,
    profile: 'test',
  }
  const authorization = authorizeTargetIdentity(input.effectiveIdentity, {
    allowlist: input.authorizationConfig?.allowlist,
    denylist: input.authorizationConfig?.denylist,
    protectedOriginalReference: config.PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE,
  })
  if (!authorization.authorized) {
    return { valid: false, errors: authorization.errors, warnings: configuration.warnings, config, target: null }
  }

  const comparison = identitiesMatchExactly(target, authorization.identity)
  if (!comparison.matches) {
    return {
      valid: false,
      errors: ['A identidade efetiva do ambiente de teste diverge do destino declarado', ...comparison.errors],
      warnings: configuration.warnings,
      config,
      target: null,
    }
  }

  return { valid: true, errors: [], warnings: configuration.warnings, config, target: authorization.identity }
}

function validateResourceReceipt(receipt, tracker) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return ['Recibo de criação do recurso de teste é obrigatório']
  }

  if (receipt.executionId !== tracker.executionId || receipt.createdByCurrentExecution !== true) {
    return ['Recibo não comprova que o recurso foi criado pela execução atual']
  }

  if (!['schema', 'table'].includes(receipt.kind) || typeof receipt.identifier !== 'string' || receipt.identifier.trim().length === 0) {
    return ['Recibo de recurso deve informar somente schema ou table e identificador não vazio']
  }

  return []
}

/**
 * Prepara um rastreador inerte para PostgreSQL de teste. O setup valida T012 com estado vazio,
 * perfil/identidade `test` e allowlist/denylist antes de entregar um token de execução. Não abre
 * conexão, cria recursos ou executa SQL; a camada de integração futura deverá fornecer adaptador
 * autenticado e recibos de criação para cada recurso realmente criado.
 *
 * @param {{ environment?: Record<string, unknown>, authorizationConfig?: object, effectiveIdentity?: object, databaseState?: object, executionId?: string }} input Evidência declarativa e id de execução do runner.
 * @returns {object} Resultado `validated` com tracker opaco ou `blocked`.
 */
export function preparePostgresTestEnvironment(input = {}) {
  const identity = validateTestIdentity(input)
  if (!identity.valid) {
    return createBlockedResult(STAGE, identity.errors, {}, identity.warnings)
  }

  if (typeof input.executionId !== 'string' || input.executionId.trim().length === 0) {
    return createBlockedResult(STAGE, ['executionId não vazio é obrigatório para rastrear recursos da execução atual'], {}, identity.warnings)
  }

  const databasePreflight = runDatabasePreflight({
    environment: input.environment,
    authorizationConfig: input.authorizationConfig,
    databaseState: input.databaseState,
  })
  if (databasePreflight.blocked) {
    return createBlockedResult(STAGE, databasePreflight.errors, { databasePreflight }, databasePreflight.warnings)
  }

  const tracker = Object.freeze({})
  trackers.set(tracker, Object.freeze({ executionId: input.executionId.trim(), target: identity.target, resources: [] }))
  return createSuccessResult(STAGE, 'validated', { tracker, target: identity.target }, identity.warnings)
}

/**
 * Registra somente recibo de criação associado ao tracker opaco da execução corrente. Nomes de
 * schema/tabela nunca são usados como prova de propriedade e nenhum recurso é removido aqui.
 *
 * @param {{ tracker?: object, receipt?: { executionId: string, createdByCurrentExecution: boolean, kind: 'schema'|'table', identifier: string } }} input Tracker emitido por prepare e recibo do adaptador futuro.
 * @returns {object} Resultado `validated` ou `blocked`.
 */
export function recordCreatedTestResource(input = {}) {
  const tracker = input.tracker
  const state = trackers.get(tracker)
  if (!state) {
    return createBlockedResult(STAGE, ['Tracker de recursos de teste desconhecido ou não emitido pela execução atual'])
  }

  const errors = validateResourceReceipt(input.receipt, state)
  if (errors.length > 0) {
    return createBlockedResult(STAGE, errors)
  }

  if (state.resources.some(resource => resource.kind === input.receipt.kind && resource.identifier === input.receipt.identifier)) {
    return createBlockedResult(STAGE, ['Recibo duplicado para recurso de teste da execução atual'])
  }

  state.resources.push(Object.freeze({ kind: input.receipt.kind, identifier: input.receipt.identifier }))
  return createSuccessResult(STAGE, 'validated', { trackedResourceCount: state.resources.length })
}

/**
 * Revalida perfil e identidade antes de delegar cleanup ao adaptador explicitamente injetado. Só
 * envia recursos previamente registrados pelo tracker da execução corrente; não aceita cleanup de
 * database e não expõe SQL/DDL. Um adaptador ausente bloqueia sem efeitos externos.
 *
 * @param {{ environment?: Record<string, unknown>, authorizationConfig?: object, effectiveIdentity?: object, tracker?: object, resourceExecutor?: { cleanupOwnedResources?: (resources: readonly object[]) => Promise<void> } }} input Evidência atual e adaptador de cleanup futuro.
 * @returns {Promise<object>} Resultado `validated` ou `blocked`.
 */
export async function cleanupPostgresTestEnvironment(input = {}) {
  const identity = validateTestIdentity(input)
  if (!identity.valid) {
    return createBlockedResult(STAGE, identity.errors, {}, identity.warnings)
  }

  const state = trackers.get(input.tracker)
  if (!state) {
    return createBlockedResult(STAGE, ['Tracker de recursos de teste desconhecido ou não emitido pela execução atual'], {}, identity.warnings)
  }

  const comparison = identitiesMatchExactly(state.target, identity.target)
  if (!comparison.matches) {
    return createBlockedResult(STAGE, ['O tracker pertence a outra identidade de teste; cleanup bloqueado'], {}, identity.warnings)
  }

  if (!input.resourceExecutor || typeof input.resourceExecutor.cleanupOwnedResources !== 'function') {
    return createBlockedResult(STAGE, ['Executor explícito de cleanup de recursos próprios é obrigatório'], {
      trackedResourceCount: state.resources.length,
    }, identity.warnings)
  }

  try {
    await input.resourceExecutor.cleanupOwnedResources(Object.freeze([...state.resources]))
    trackers.delete(input.tracker)
    return createSuccessResult(STAGE, 'validated', {
      cleanedResourceCount: state.resources.length,
      cleanupScope: 'current-execution-owned-resources-only',
    }, identity.warnings)
  } catch {
    return createBlockedResult(STAGE, ['Executor de cleanup de recursos próprios falhou'], {
      trackedResourceCount: state.resources.length,
    }, identity.warnings)
  }
}