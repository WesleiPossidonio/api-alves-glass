#!/usr/bin/env node
/**
 * Status do baseline de persistência.
 * Verifica estado das migrations do baseline sem executar DDL.
 * Usa configuração exclusiva do baseline, não depende de .sequelizerc legado.
 */

import dotenv from 'dotenv'
dotenv.config()

import { Sequelize, Umzug } from 'sequelize'
import pg from 'pg'
import baselineConfig from './baseline/config/database.js'

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
 * Verifica status das migrations do baseline.
 * @returns {Object} Resultado do status
 */
export async function checkBaselineStatus() {
  const result = {
    stage: 'baseline-status',
    pendingMigrations: [],
    executedMigrations: [],
    alreadyCurrent: false,
    blocked: false,
    errors: [],
    warnings: [],
  }

  let sequelize

  try {
    sequelize = createBaselineSequelize()
    await sequelize.authenticate()

    const umzug = createBaselineUmzug(sequelize)

    // Lista migrations executadas
    const executed = await umzug.executed()
    result.executedMigrations = executed.map(m => m.name)

    // Lista migrations pendentes
    const pending = await umzug.pending()
    result.pendingMigrations = pending.map(m => m.name)

    result.alreadyCurrent = result.pendingMigrations.length === 0

    return result

  } catch (error) {
    result.errors.push(`Erro ao verificar status do baseline: ${error.message}`)
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
  console.log('[BASELINE-STATUS] Verificando status do baseline...')
  console.log(`[BASELINE-STATUS] Caminho canônico: ${CANONICAL_BASELINE_MIGRATIONS_PATH}`)

  const status = await checkBaselineStatus()

  if (status.blocked) {
    console.error('[BASELINE-STATUS] BLOQUEADO:', status.errors.join('; '))
    process.exit(1)
  }

  console.log('[BASELINE-STATUS] Migrations executadas:', status.executedMigrations.length)
  console.log('[BASELINE-STATUS] Migrations pendentes:', status.pendingMigrations.length)

  if (status.alreadyCurrent) {
    console.log('[BASELINE-STATUS] Estado: already-current (sem migrations pendentes)')
  } else {
    console.log('[BASELINE-STATUS] Estado: pending-migrations')
    console.log('[BASELINE-STATUS] Pendentes:', status.pendingMigrations)
  }

  console.log('BASELINE_STATUS_RESULT=' + JSON.stringify(status))
}

main().catch((error) => {
  console.error('[BASELINE-STATUS] Erro fatal:', error.message)
  process.exit(1)
})