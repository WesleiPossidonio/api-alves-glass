import fs from 'node:fs'
import path from 'node:path'
import { createBaselineCliConfig } from './baseline-cli-config.js'
import { createBlockedResult, createSuccessResult } from './operation-result.js'

const STAGE = 'baseline-cli-runner'
const ALLOWED_INPUT_FIELDS = new Set(['cliConfiguration', 'processExecutor', 'filesystem'])
const ALLOWED_PROFILES = new Set(['development-rebuild', 'test'])
const FIXED_EXECUTABLE = 'sequelize-cli'

function sanitizeProcessFailure(error) {
  const message = error instanceof Error && typeof error.message === 'string'
    ? error.message
    : 'erro desconhecido'

  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[DATABASE_URL_REDACTED]')
    .replace(/\b(password|pwd|BASELINE_DB_PASSWORD)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(username|user|BASELINE_DB_USERNAME)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
}

function validateInputShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['A entrada do runner do CLI deve ser um objeto']
  }

  return Object.keys(input)
    .filter(field => !ALLOWED_INPUT_FIELDS.has(field))
    .map(field => `Campo não permitido para o runner do CLI: ${field}`)
}

function deriveProjectRoot(configPath) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) {
    return null
  }

  return path.resolve(path.dirname(configPath), '..', '..', '..')
}

function sameArguments(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((argument, index) => argument === right[index])
}

function validateApprovedCliConfiguration(cliConfiguration, filesystem) {
  if (!cliConfiguration || typeof cliConfiguration !== 'object' || Array.isArray(cliConfiguration)) {
    return { valid: false, errors: ['Configuração operacional validada do baseline é obrigatória'] }
  }

  if (cliConfiguration.blocked || cliConfiguration.state !== 'validated' || cliConfiguration.stage !== 'baseline-cli-config') {
    return { valid: false, errors: ['Configuração operacional do baseline deve estar validated e não bloqueada'] }
  }

  const details = cliConfiguration.details
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return { valid: false, errors: ['Configuração operacional validada não contém detalhes do CLI'] }
  }

  if (!ALLOWED_PROFILES.has(details.environment)) {
    return { valid: false, errors: ['Configuração operacional contém perfil não autorizado para o CLI'] }
  }

  const projectRoot = deriveProjectRoot(details.configPath)
  if (!projectRoot) {
    return { valid: false, errors: ['O --config do baseline deve ser absoluto e canônico'] }
  }

  const rebuiltConfiguration = createBaselineCliConfig({
    projectRoot,
    profile: details.environment,
    migrationsPath: details.migrationsPath,
    filesystem,
  })

  if (rebuiltConfiguration.blocked) {
    return {
      valid: false,
      errors: ['Configuração operacional não pode ser revalidada para execução controlada', ...rebuiltConfiguration.errors],
    }
  }

  const expected = rebuiltConfiguration.details
  if (
    details.executable !== FIXED_EXECUTABLE ||
    details.configPath !== expected.configPath ||
    details.migrationsPath !== expected.migrationsPath ||
    !sameArguments(details.arguments, expected.arguments) ||
    JSON.stringify(details.metadata) !== JSON.stringify(expected.metadata)
  ) {
    return { valid: false, errors: ['Configuração operacional diverge da declaração canônica aprovada do baseline'] }
  }

  return Object.freeze({
    valid: true,
    projectRoot,
    command: FIXED_EXECUTABLE,
    arguments: Object.freeze([...expected.arguments]),
    profile: expected.environment,
    migrationsPath: expected.migrationsPath,
    metadataRelation: 'baseline_meta.SequelizeMetaBaseline',
  })
}

/**
 * Executa somente a declaração de sequelize-cli revalidada contra T013–T015. O chamador não pode
 * fornecer argumentos, identidades, listas de autorização ou flags: T030 deverá fornecer a
 * configuração já autorizada pelos preflights. Não existe executor padrão, portanto importar este
 * módulo ou chamá-lo sem adaptador injetado jamais inicia processo, conexão, CLI ou DDL.
 *
 * @param {{ cliConfiguration?: object, processExecutor?: { run?: (command: string, argumentsList: readonly string[], options: { cwd: string, shell: false, stdio: 'pipe' }) => Promise<{ exitCode?: number }> }, filesystem?: object }} input Dependências explícitas e inertes.
 * @returns {Promise<object>} Resultado `validated` após processo controlado ou `blocked`.
 */
export async function runBaselineCli(input = {}) {
  const shapeErrors = validateInputShape(input)
  if (shapeErrors.length > 0) {
    return createBlockedResult(STAGE, shapeErrors)
  }

  const configuration = validateApprovedCliConfiguration(input.cliConfiguration, input.filesystem ?? fs)
  if (!configuration.valid) {
    return createBlockedResult(STAGE, configuration.errors)
  }

  if (!input.processExecutor || typeof input.processExecutor.run !== 'function') {
    return createBlockedResult(STAGE, [
      'Executor de processo explícito é obrigatório; T030 deve fornecer o adaptador operacional após os preflights',
    ], {
      profile: configuration.profile,
      migrationsPath: configuration.migrationsPath,
      metadataRelation: configuration.metadataRelation,
    })
  }

  try {
    const execution = await input.processExecutor.run(configuration.command, configuration.arguments, Object.freeze({
      cwd: configuration.projectRoot,
      shell: false,
      stdio: 'pipe',
    }))

    if (!execution || execution.exitCode !== 0) {
      return createBlockedResult(STAGE, ['sequelize-cli controlado retornou falha'], {
        profile: configuration.profile,
        migrationsPath: configuration.migrationsPath,
        metadataRelation: configuration.metadataRelation,
      })
    }

    return createSuccessResult(STAGE, 'validated', {
      executable: configuration.command,
      arguments: configuration.arguments,
      profile: configuration.profile,
      migrationsPath: configuration.migrationsPath,
      metadataRelation: configuration.metadataRelation,
    })
  } catch (error) {
    return createBlockedResult(STAGE, [
      `Executor controlado do sequelize-cli falhou: ${sanitizeProcessFailure(error)}`,
    ], {
      profile: configuration.profile,
      migrationsPath: configuration.migrationsPath,
      metadataRelation: configuration.metadataRelation,
    })
  }
}