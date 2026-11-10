import { pathToFileURL } from 'node:url'
import { loadPersistenceConfig, redactPersistenceConfig } from '../../../src/infrastructure/config/persistence-config.js'
import { createBlockedResult } from '../../../src/infrastructure/persistence/operation-result.js'

const ORCHESTRATOR_MODULE_PATH = '../../../src/infrastructure/persistence/baseline-rebuild.js'

function normalizeProfile(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Aceita exclusivamente o argumento documentado `--profile <perfil>` ou `--profile=<perfil>`.
 * A entrada não recebe identidade efetiva, listas, estado do database, executores ou flags de
 * autorização: essas evidências devem ser obtidas por adaptador confiável no T030 futuro.
 *
 * @param {string[]} argumentsList Argumentos sem `node` e sem o caminho do script.
 * @returns {{ valid: boolean, errors: string[], profile: string | null }} Resultado sem efeitos externos.
 */
export function parseBaselineArguments(argumentsList = []) {
  if (!Array.isArray(argumentsList) || argumentsList.some(argument => typeof argument !== 'string')) {
    return { valid: false, errors: ['Argumentos do baseline devem ser uma lista de strings'], profile: null }
  }

  const errors = []
  let profile = null
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--profile') {
      if (profile !== null) {
        errors.push('O argumento --profile não pode ser informado mais de uma vez')
        continue
      }

      profile = normalizeProfile(argumentsList[index + 1])
      if (!profile) {
        errors.push('O argumento --profile exige um valor não vazio')
      }
      index += 1
      continue
    }

    if (argument.startsWith('--profile=')) {
      if (profile !== null) {
        errors.push('O argumento --profile não pode ser informado mais de uma vez')
        continue
      }

      profile = normalizeProfile(argument.slice('--profile='.length))
      if (!profile) {
        errors.push('O argumento --profile exige um valor não vazio')
      }
      continue
    }

    errors.push(`Argumento não permitido para baseline: ${argument}`)
  }

  if (profile === null && !errors.some(error => error.includes('--profile exige'))) {
    errors.push('O argumento --profile é obrigatório')
  }

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors), profile })
}

async function loadFutureBaselineOrchestrator() {
  return import(ORCHESTRATOR_MODULE_PATH)
}

/**
 * Entrada passiva de baseline: valida argumentos/configuração e delega exclusivamente ao futuro
 * T030. Enquanto T030 estiver ausente, retorna `blocked`; não implementa bootstrap, preflight,
 * CLI, metadata, recovery ou qualquer executor de banco.
 *
 * Risco preservado: identidade efetiva, estado do database e allowlist/denylist reais devem ser
 * obtidos e vinculados por adaptador operacional confiável antes de qualquer executor real.
 *
 * @param {{ arguments?: string[], environment?: Record<string, unknown>, orchestratorLoader?: () => Promise<object> }} input Dados de entrada inertes e loader futuro injetável para teste.
 * @returns {Promise<object>} Resultado padronizado do orquestrador ou `blocked`.
 */
export async function runBaseline(input = {}) {
  const parsedArguments = parseBaselineArguments(input.arguments ?? [])
  if (!parsedArguments.valid) {
    return createBlockedResult('run-baseline', parsedArguments.errors)
  }

  const configuration = loadPersistenceConfig(input.environment ?? {}, {
    requiresConnectionCredentials: false,
  })
  if (!configuration.valid) {
    return createBlockedResult('run-baseline', configuration.errors, {
      configuration: redactPersistenceConfig(configuration.config),
    }, configuration.warnings)
  }

  if (configuration.config.PERSISTENCE_PROFILE !== parsedArguments.profile) {
    return createBlockedResult('run-baseline', [
      'O --profile deve corresponder exatamente a PERSISTENCE_PROFILE; argumentos não podem selecionar destino alternativo',
    ], {
      requestedProfile: parsedArguments.profile,
      configuredProfile: configuration.config.PERSISTENCE_PROFILE,
    }, configuration.warnings)
  }

  let orchestratorModule
  try {
    orchestratorModule = await (input.orchestratorLoader ?? loadFutureBaselineOrchestrator)()
  } catch {
    return createBlockedResult('run-baseline', [
      'Orquestrador T030 indisponível; baseline permanece bloqueado sem bootstrap, CLI ou DDL',
    ], {
      profile: parsedArguments.profile,
      risk: 'A identidade efetiva, estado do database e listas reais exigem adaptador operacional confiável antes de executor real',
    }, configuration.warnings)
  }

  if (!orchestratorModule || typeof orchestratorModule.rebuildBaseline !== 'function') {
    return createBlockedResult('run-baseline', [
      'Orquestrador T030 inválido; exportação rebuildBaseline é obrigatória para delegação controlada',
    ], {
      profile: parsedArguments.profile,
    }, configuration.warnings)
  }

  return orchestratorModule.rebuildBaseline({
    profile: parsedArguments.profile,
    config: configuration.config,
  })
}

async function main() {
  const result = await runBaseline({
    arguments: process.argv.slice(2),
    environment: process.env,
  })

  console.log(JSON.stringify(result))
  if (result.blocked) {
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify(createBlockedResult('run-baseline', [
      `Falha inesperada na entrada de baseline: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
    ])))
    process.exitCode = 1
  })
}