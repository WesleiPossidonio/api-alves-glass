#!/usr/bin/env node
/**
 * Aplicação do baseline de persistência.
 * Executa migrations do baseline somente após preflights validados e banco criado.
 * Valida baseline_meta.SequelizeMetaBaseline após execução do CLI.
 * Não executa DROP, não recria banco existente.
 */

import dotenv from 'dotenv'
dotenv.config()

import { Sequelize, Umzug } from 'sequelize'
import pg from 'pg'
import baselineConfig from './baseline/config/database.js'
import { runInstancePreflight, runDatabaseIdentityPreflight } from './preflight.js'
import { createProtectedDatabase, validateBaselineMetaSchema } from './bootstrap-protected.js'
import { checkBaselineStatus } from './baseline-status.js'

const CANONICAL_BASELINE_MIGRATIONS_PATH = '/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone/src/infra/persistence/baseline/migrations'

/**
 * Cria instância do Sequelize configurada para o baseline.
 * @returns {Sequelize} Instância configurada
 */
function createBaselineSequelize() {
  return new Sequelize({
    ...baselineConfig,
    dialectModule: pg,
  })
}

/**
 * Cria instância do Umzug para o baseline.
 * @param {Sequelize} sequelize - Instância do Sequelize
 * @returns {Umzug} Instância do Umzug configurada
 */
function createBaselineUmzug(sequelize) {
  return new Umzug({
    migrations: {
      glob: `${CANONICAL_BASELINE_MIGRATIONS_PATH}/*.js`,
      resolve: ({ name, path, context }) => {
        const migration = import(path)
        return {
          name,
          up: () => migration.up(context, sequelize.getQueryInterface()),
          down: () => migration.down(context, sequelize.getQueryInterface()),
        }
      },
    },
    context: sequelize.getQueryInterface(),
    storage: 'sequelize',
    storageOptions: {
      sequelize,
      tableName: 'SequelizeMetaBaseline',
      schema: 'baseline_meta',
    },
    logger: console,
  })
}
/**
 * Aplica migrations do baseline.
 * @param {Object} preflightResult - Resultado dos preflights validados
 * @returns {Object} Resultado da aplicação
 */
export async function applyBaseline(preflightResult) {
  const result = {
    stage: 'baseline-apply',
    profile: preflightResult.instance.profile,
    status: 'unknown',
    appliedMigrations: [],
    alreadyRecorded: [],
    blocked: false,
    errors: [],
    warnings: [],
  }

  let sequelize

  try {
    const status = await checkBaselineStatus()
    if (status.blocked) {
      result.errors.push(...status.errors)
      result.blocked = true
      return result
    }

    if (status.alreadyCurrent) {
      result.status = 'already-current'
      result.warnings.push('Baseline já aplicado (already-current). Nenhuma migration executada.')
      return result
    }

    if (status.executedMigrations.length > 0 && status.pendingMigrations.length > 0) {
      result.status = 'recovery-required'
      result.errors.push('Divergência detectada: migrations executadas e pendentes coexistem. Recovery manual necessário.')
      result.blocked = true
      return result
    }

    sequelize = createBaselineSequelize()
    await sequelize.authenticate()

    const umzug = createBaselineUmzug(sequelize)

    const applied = await umzug.up()
    result.appliedMigrations = applied.map(m => m.name)

    if (result.appliedMigrations.length === 0) {
      result.status = 'migration-already-recorded'
      result.warnings.push('Nenhuma migration aplicada (migration-already-recorded).')
    } else {
      result.status = 'rebuild-complete'
    }

    const identity = preflightResult.instance.identity
    const metaValidation = await validateBaselineMetaSchema(identity)
    if (metaValidation.blocked) {
      result.errors.push(...metaValidation.errors)
      result.blocked = true
      return result
    }

    if (metaValidation.warnings.length > 0) {
      result.warnings.push(...metaValidation.warnings)
    }

    return result

  } catch (error) {
    result.errors.push(`Erro ao aplicar baseline: ${error.message}`)
    result.blocked = true
    return result
  } finally {
    if (sequelize) {
      await sequelize.close()
    }
  }
}

// CLI entry point
async function main() {
  const profile = process.argv[2] || 'development-rebuild'

  console.log(`[BASELINE-APPLY] Iniciando aplicação do baseline para perfil: ${profile}`)

  const instanceResult = await runInstancePreflight(profile)
  if (instanceResult.blocked) {
    console.error('[BASELINE-APPLY] Preflight da instância BLOQUEADO:', instanceResult.errors.join('; '))
    process.exit(1)
  }
  console.log('[BASELINE-APPLY] Preflight da instância: VALIDADO')

  const dbIdentityResult = await runDatabaseIdentityPreflight({ instance: instanceResult, database: { validated: true, profile: instanceResult.profile } })
  if (dbIdentityResult.blocked) {
    console.error('[BASELINE-APPLY] Preflight de identidade do banco BLOQUEADO:', dbIdentityResult.errors.join('; '))
    process.exit(1)
  }
  console.log('[BASELINE-APPLY] Preflight de identidade do banco: VALIDADO')

  const preflightResult = { instance: instanceResult, database: dbIdentityResult }
  const createResult = await createProtectedDatabase(preflightResult)
  if (createResult.blocked) {
    console.error('[BASELINE-APPLY] Criação protegida BLOQUEADA:', createResult.errors.join('; '))
    process.exit(1)
  }

  if (createResult.databaseCreated) {
    console.log('[BASELINE-APPLY] Banco criado: database-created')
  } else if (createResult.databaseExists) {
    console.log('[BASELINE-APPLY] Banco já existe: database-exists')
  }

  const applyResult = await applyBaseline(preflightResult)

  if (applyResult.blocked) {
    console.error('[BASELINE-APPLY] Aplicação BLOQUEADA:', applyResult.errors.join('; '))
    process.exit(1)
  }

  console.log(`[BASELINE-APPLY] Status: ${applyResult.status}`)
  console.log('[BASELINE-APPLY] Migrations aplicadas:', applyResult.appliedMigrations)

  if (applyResult.warnings.length > 0) {
    console.log('[BASELINE-APPLY] Avisos:', applyResult.warnings.join('; '))
  }

  console.log('BASELINE_APPLY_RESULT=' + JSON.stringify({ preflight: preflightResult, create: createResult, apply: applyResult }))
}

main().catch((error) => {
  console.error('[BASELINE-APPLY] Erro fatal:', error.message)
  process.exit(1)
})