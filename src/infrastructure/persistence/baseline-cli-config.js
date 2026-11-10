import fs from 'node:fs'
import path from 'node:path'
import { createBlockedResult, createSuccessResult } from './operation-result.js'
import { createBaselineMetadataConfig, validateBaselineMetadataConfig } from './metadata-config.js'
import { validateBaselineMigrationsPath } from './migrations-path.js'

const CLI_PROFILES = new Set(['development-rebuild', 'test'])

function getCanonicalBaselineConfigPath(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0 || !path.isAbsolute(projectRoot.trim())) {
    return null
  }

  return path.resolve(projectRoot.trim(), 'src', 'database', 'baseline', 'config.cjs')
}

function isRegularFile(filesystem, candidatePath) {
  try {
    return filesystem.statSync(candidatePath).isFile()
  } catch {
    return false
  }
}

/**
 * Monta, sem executar, a configuração exclusiva para futura invocação do sequelize-cli. A chamada
 * sempre declara `--config`, `--env` e `--migrations-path`; não consulta `.sequelizerc`, não usa
 * Umzug diretamente e não inicia conexões.
 *
 * @param {{ projectRoot?: unknown, profile?: unknown, migrationsPath?: unknown, filesystem?: object }} input Dados declarativos e filesystem injetável para T013.
 * @returns {object} Resultado `validated` quando o conjunto canônico estiver pronto; caso contrário, `blocked`.
 */
export function createBaselineCliConfig(input = {}) {
  const filesystem = input.filesystem ?? fs
  const migrationPathValidation = validateBaselineMigrationsPath({
    projectRoot: input.projectRoot,
    configuredPath: input.migrationsPath,
    filesystem,
  })
  const configPath = getCanonicalBaselineConfigPath(input.projectRoot)
  const metadataValidation = validateBaselineMetadataConfig(createBaselineMetadataConfig())
  const errors = [...migrationPathValidation.errors, ...metadataValidation.errors]

  if (typeof input.profile !== 'string' || !CLI_PROFILES.has(input.profile)) {
    errors.push('O executor do baseline aceita somente os perfis development-rebuild ou test')
  }

  if (!configPath) {
    errors.push('A raiz do projeto deve ser absoluta para derivar o --config exclusivo do baseline')
  } else if (!filesystem.existsSync(configPath)) {
    errors.push('O arquivo --config exclusivo do baseline não existe')
  } else if (!isRegularFile(filesystem, configPath)) {
    errors.push('O arquivo --config exclusivo do baseline deve ser um arquivo regular')
  }

  if (errors.length > 0 || !migrationPathValidation.operationallyReady) {
    return createBlockedResult('baseline-cli-config', [
      ...errors,
      ...(migrationPathValidation.operationallyReady
        ? []
        : ['O conjunto canônico de migrations não está pronto; sequelize-cli permanece bloqueado']),
    ], {
      configPath,
      migrationPath: migrationPathValidation,
      metadataRelation: metadataValidation.relation,
    }, migrationPathValidation.warnings)
  }

  const metadata = metadataValidation.config
  const argumentsList = Object.freeze([
    'db:migrate',
    '--config', configPath,
    '--env', input.profile,
    '--migrations-path', migrationPathValidation.canonicalPath,
  ])

  return createSuccessResult('baseline-cli-config', 'validated', {
    executable: 'sequelize-cli',
    arguments: argumentsList,
    configPath,
    environment: input.profile,
    migrationsPath: migrationPathValidation.canonicalPath,
    metadata,
  })
}