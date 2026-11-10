import { runBaselineCli } from './baseline-cli-runner.js'
import { validateBaselineMetadata } from './metadata-validator.js'
import { diagnoseMigrationRecovery } from './migration-recovery.js'
import { createBlockedResult, createSuccessResult } from './operation-result.js'
import { isAuthenticatedPostgresStatusObservation } from './postgres-status-observer.js'

const STAGE = 'baseline-rebuild'
const ALLOWED_INPUT_FIELDS = new Set([
  'profile',
  'config',
  'databasePreflight',
  'cliConfiguration',
  'processExecutor',
  'metadataObserver',
  'recoveryEvidence',
  'requestedMigrationName',
  'filesystem',
  'mode',
  'statusObserver',
  'declaredTarget',
  'authorizationConfig',
  'canonicalMigrations',
])

function validateInputShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['A entrada do orquestrador de baseline deve ser um objeto']
  }

  return Object.keys(input)
    .filter(field => !ALLOWED_INPUT_FIELDS.has(field))
    .map(field => `Campo não permitido para o orquestrador de baseline: ${field}`)
}

function validateProfileAndConfig(input) {
  const errors = []
  if (!['development-rebuild', 'test'].includes(input.profile)) {
    errors.push('O orquestrador aceita somente os perfis development-rebuild ou test')
  }

  if (!input.config || typeof input.config !== 'object' || Array.isArray(input.config)) {
    errors.push('Configuração validada de persistência é obrigatória')
  } else if (input.config.PERSISTENCE_PROFILE !== input.profile) {
    errors.push('O perfil solicitado deve corresponder exatamente à configuração validada')
  }

  return errors
}

function validateDatabasePreflight(preflight) {
  if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight)) {
    return ['Preflight de database validado é obrigatório antes do baseline']
  }

  if (preflight.stage !== 'database-preflight' || preflight.state !== 'validated' || preflight.blocked !== false) {
    return ['O baseline exige database-preflight validated e não bloqueado']
  }

  if (preflight.details?.databaseState?.exists !== true || preflight.details?.databaseState?.isEmpty !== true) {
    return ['O baseline inicial exige database existente e comprovadamente vazio']
  }

  return []
}

function isRecoveryEvidence(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Único ponto de composição do baseline. Recebe apenas resultados de preflight e adaptadores
 * explicitamente injetados; não abre conexão, não lê identidade local, não executa bootstrap e não
 * cria executor padrão. A ausência de qualquer prova ou adaptador bloqueia. Em particular, T006
 * continua obrigatório para adaptadores operacionais reais, e nenhuma operação é liberada só pela
 * configuração declarada.
 *
 * @param {{ profile?: 'development-rebuild'|'test', config?: object, databasePreflight?: object, cliConfiguration?: object, processExecutor?: object, metadataObserver?: object, recoveryEvidence?: object, requestedMigrationName?: string, filesystem?: object, mode?: 'apply'|'status', statusObserver?: { observeBaselineStatus?: (input: object) => Promise<object> }, declaredTarget?: object, authorizationConfig?: object, canonicalMigrations?: string[] }} input Dependências já autorizadas e injetadas.
 * @returns {Promise<object>} Resultado `rebuild-complete`, `already-current`, `migration-already-recorded`, `recovery-required` ou `blocked`.
 */
export async function rebuildBaseline(input = {}) {
  const shapeErrors = validateInputShape(input)
  if (shapeErrors.length > 0) {
    return createBlockedResult(STAGE, shapeErrors)
  }

  const profileErrors = validateProfileAndConfig(input)
  if (profileErrors.length > 0) {
    return createBlockedResult(STAGE, profileErrors)
  }

  if (input.mode !== undefined && !['apply', 'status'].includes(input.mode)) {
    return createBlockedResult(STAGE, ['mode deve ser apply ou status quando informado'], { profile: input.profile })
  }

  const mode = input.mode ?? 'apply'
  if (mode === 'apply') {
    const preflightErrors = validateDatabasePreflight(input.databasePreflight)
    if (preflightErrors.length > 0) {
      return createBlockedResult(STAGE, preflightErrors, { profile: input.profile })
    }

    if (!input.cliConfiguration || !input.processExecutor || !input.metadataObserver || !isRecoveryEvidence(input.recoveryEvidence)) {
      return createBlockedResult(STAGE, [
        'Aplicação controlada exige configuração CLI, executor, observador de metadata e evidência de recovery explícitos',
      ], { profile: input.profile })
    }

    const cliExecution = await runBaselineCli({
      cliConfiguration: input.cliConfiguration,
      processExecutor: input.processExecutor,
      filesystem: input.filesystem,
    })
    if (cliExecution.blocked) {
      return createBlockedResult(STAGE, cliExecution.errors, { profile: input.profile, cliExecution }, cliExecution.warnings)
    }

    const metadataValidation = await validateBaselineMetadata({
      cliExecution,
      metadataObserver: input.metadataObserver,
    })
    if (metadataValidation.blocked) {
      return createBlockedResult(STAGE, metadataValidation.errors, {
        profile: input.profile,
        cliExecution,
        metadataValidation,
      }, metadataValidation.warnings)
    }

    const recovery = diagnoseMigrationRecovery({
      metadataValidation,
      recoveryEvidence: input.recoveryEvidence,
      requestedMigrationName: input.requestedMigrationName,
    })
    if (recovery.state === 'recovery-required') {
      return createBlockedResult(STAGE, recovery.errors, {
        profile: input.profile,
        cliExecution,
        metadataValidation,
        recovery,
      }, recovery.warnings, 'recovery-required')
    }
    if (recovery.blocked) {
      return createBlockedResult(STAGE, recovery.errors, {
        profile: input.profile,
        cliExecution,
        metadataValidation,
        recovery,
      }, recovery.warnings)
    }

    return createSuccessResult(STAGE, 'rebuild-complete', {
      profile: input.profile,
      cliExecution,
      metadataValidation,
      recovery,
    }, recovery.warnings)
  }

  if (!input.statusObserver || typeof input.statusObserver.observeBaselineStatus !== 'function') {
    return createBlockedResult(STAGE, ['Status não destrutivo exige observador autenticado e estritamente read-only'], {
      profile: input.profile,
    })
  }

  if (input.requestedMigrationName !== undefined) {
    return createBlockedResult(STAGE, ['Status não destrutivo não aceita requestedMigrationName nem classifica reaplicação'], {
      profile: input.profile,
    })
  }

  const observation = await input.statusObserver.observeBaselineStatus({
    declaredTarget: input.declaredTarget,
    authorizationConfig: input.authorizationConfig,
    canonicalMigrations: input.canonicalMigrations,
  })
  if (!isAuthenticatedPostgresStatusObservation(observation) || observation.stage !== 'postgres-status-observer') {
    const diagnostics = observation?.stage === 'postgres-status-observer' && Array.isArray(observation.errors) && observation.errors.length > 0
      ? observation.errors
      : ['Observador de status retornou resultado não emitido pela infraestrutura autenticada']
    return createBlockedResult(STAGE, diagnostics, {
      profile: input.profile,
    })
  }

  if (observation.blocked || observation.state !== 'validated') {
    return createBlockedResult(STAGE, observation.errors?.length > 0
      ? observation.errors
      : ['Observação autenticada não comprovou estado seguro para status'], {
      profile: input.profile,
      observation,
    }, observation.warnings ?? [])
  }

  const recoveryBeforeCli = diagnoseMigrationRecovery({
    metadataValidation: observation.details?.metadataValidation,
    recoveryEvidence: observation.details?.recoveryEvidence,
  })

  if (recoveryBeforeCli.state === 'recovery-required') {
    return createBlockedResult(STAGE, recoveryBeforeCli.errors, {
      profile: input.profile,
      observation,
      recovery: recoveryBeforeCli,
    }, recoveryBeforeCli.warnings, 'recovery-required')
  }

  if (recoveryBeforeCli.state === 'already-current') {
    return createSuccessResult(STAGE, recoveryBeforeCli.state, {
      profile: input.profile,
      observation,
      recovery: recoveryBeforeCli,
    }, recoveryBeforeCli.warnings)
  }

  if (recoveryBeforeCli.blocked) {
    return createBlockedResult(STAGE, recoveryBeforeCli.errors, {
      profile: input.profile,
      observation,
      recovery: recoveryBeforeCli,
    }, recoveryBeforeCli.warnings)
  }

  return createBlockedResult(STAGE, [
    'Estado de recovery não reconhecido; baseline permanece bloqueado',
  ], { profile: input.profile, observation, recovery: recoveryBeforeCli })
}