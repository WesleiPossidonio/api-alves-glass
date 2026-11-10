#!/usr/bin/env node
/**
 * Bootstrap protegido do banco isolado.
 * Executa criação protegida do banco (etapa 2) somente após preflight da instância validado.
 * Não executa DROP DATABASE, não substitui banco existente, não toca instância original.
 */

import dotenv from 'dotenv'
dotenv.config()

import pg from 'pg'
import { runInstancePreflight, runDatabaseIdentityPreflight } from './preflight.js'

const CANONICAL_BASELINE_MIGRATIONS_PATH = '/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone/src/infra/persistence/baseline/migrations'

/**
 * Cria banco de dados isolado de forma protegida.
 * Somente cria se o banco estiver ausente na instância validada.
 * @param {Object} preflightResult - Resultado do preflight validado
 * @returns {Object} Resultado da criação
 */
export async function createProtectedDatabase(preflightResult) {
  const result = {
    stage: 'create-protected-database',
    profile: preflightResult.profile,
    databaseCreated: false,
    databaseExists: false,
    blocked: false,
    errors: [],
    warnings: [],
  }

  try {
    if (!preflightResult.instance.validated || !preflightResult.database.validated) {
      result.errors.push('Preflights não validados')
      result.blocked = true
      return result
    }

    const identity = preflightResult.instance.identity
    const config = {
      host: identity.host,
      port: identity.port,
      user: process.env.BASELINE_DB_USERNAME,
      password: process.env.BASELINE_DB_PASSWORD,
      database: 'postgres',
    }

    const adminClient = new pg.Client(config)
    await adminClient.connect()

    try {
      const checkResult = await adminClient.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [identity.database]
      )

      if (checkResult.rows.length > 0) {
        result.databaseExists = true
        result.warnings.push(`Banco '${identity.database}' já existe na instância. Não será recriado.`)
        return result
      }

      await adminClient.query(`CREATE DATABASE "${identity.database}"`)
      result.databaseCreated = true
      console.log(`[BOOTSTRAP] Banco '${identity.database}' criado com sucesso`)

    } finally {
      await adminClient.end()
    }

    return result

  } catch (error) {
    result.errors.push(`Erro ao criar banco protegido: ${error.message}`)
    result.blocked = true
    return result
  }
}
/**
 * Valida schema baseline_meta após execução do CLI.
 * Verifica se baseline_meta.SequelizeMetaBaseline existe com estrutura esperada.
 * Não aceita search_path, public ou schema inesperado.
 * @param {Object} identity - Identidade do banco
 * @returns {Object} Resultado da validação
 */
export async function validateBaselineMetaSchema(identity) {
  const result = {
    stage: 'validate-baseline-meta',
    schemaExists: false,
    tableExists: false,
    structureValid: false,
    blocked: false,
    errors: [],
    warnings: [],
  }

  try {
    const config = {
      host: identity.host,
      port: identity.port,
      user: process.env.BASELINE_DB_USERNAME,
      password: process.env.BASELINE_DB_PASSWORD,
      database: identity.database,
    }

    const client = new pg.Client(config)
    await client.connect()

    try {
      const schemaResult = await client.query(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'baseline_meta'`
      )

      if (schemaResult.rows.length === 0) {
        result.errors.push('Schema baseline_meta não existe')
        result.blocked = true
        return result
      }
      result.schemaExists = true

      const tableResult = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'baseline_meta' AND table_name = 'SequelizeMetaBaseline'`
      )

      if (tableResult.rows.length === 0) {
        result.errors.push('Tabela baseline_meta.SequelizeMetaBaseline não existe')
        result.blocked = true
        return result
      }
      result.tableExists = true

      const columnsResult = await client.query(
        `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'baseline_meta' AND table_name = 'SequelizeMetaBaseline'`
      )

      const nameColumn = columnsResult.rows.find(r => r.column_name === 'name')
      if (!nameColumn) {
        result.errors.push('Coluna "name" não encontrada em baseline_meta.SequelizeMetaBaseline')
        result.blocked = true
        return result
      }

      if (nameColumn.is_nullable === 'YES') {
        result.errors.push('Coluna "name" deve ser NOT NULL')
        result.blocked = true
        return result
      }

      const constraintsResult = await client.query(
        `SELECT constraint_name, constraint_type
         FROM information_schema.table_constraints
         WHERE table_schema = 'baseline_meta' AND table_name = 'SequelizeMetaBaseline'`
      )

      const hasPrimaryKey = constraintsResult.rows.some(r => r.constraint_type === 'PRIMARY KEY')
      const hasUnique = constraintsResult.rows.some(r => r.constraint_type === 'UNIQUE')

      if (!hasPrimaryKey && !hasUnique) {
        result.errors.push('Tabela baseline_meta.SequelizeMetaBaseline deve ter PK ou constraint UNIQUE na coluna name')
        result.blocked = true
        return result
      }

      result.structureValid = true

      const unexpectedTableResult = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'SequelizeMetaBaseline'`
      )

      if (unexpectedTableResult.rows.length > 0) {
        result.warnings.push('Tabela homônima SequelizeMetaBaseline encontrada em schema public (ignorado, usa baseline_meta)')
      }

      return result

    } finally {
      await client.end()
    }

  } catch (error) {
    result.errors.push(`Erro ao validar schema baseline_meta: ${error.message}`)
    result.blocked = true
    return result
  }
}

// CLI entry point
async function main() {
  const profile = process.argv[2] || 'test'

  console.log(`[BOOTSTRAP] Iniciando bootstrap protegido para perfil: ${profile}`)

  const instanceResult = await runInstancePreflight(profile)
  if (instanceResult.blocked) {
    console.error('[BOOTSTRAP] Preflight da instância BLOQUEADO:', instanceResult.errors.join('; '))
    process.exit(1)
  }
  console.log('[BOOTSTRAP] Preflight da instância: VALIDADO')

  const dbIdentityResult = await runDatabaseIdentityPreflight({ instance: instanceResult, database: { validated: true, profile: instanceResult.profile } })
  if (dbIdentityResult.blocked) {
    console.error('[BOOTSTRAP] Preflight de identidade do banco BLOQUEADO:', dbIdentityResult.errors.join('; '))
    process.exit(1)
  }
  console.log('[BOOTSTRAP] Preflight de identidade do banco: VALIDADO')

  const preflightResult = { instance: instanceResult, database: dbIdentityResult }
  const createResult = await createProtectedDatabase(preflightResult)

  if (createResult.blocked) {
    console.error('[BOOTSTRAP] Criação protegida BLOQUEADA:', createResult.errors.join('; '))
    process.exit(1)
  }

  if (createResult.databaseCreated) {
    console.log('[BOOTSTRAP] Banco criado: database-created')
  } else if (createResult.databaseExists) {
    console.log('[BOOTSTRAP] Banco já existe: database-exists (não recriado)')
  }

  console.log('[BOOTSTRAP] Bootstrap protegido concluído')
  console.log('BOOTSTRAP_RESULT=' + JSON.stringify({ preflight: preflightResult, create: createResult }))
}

main().catch((error) => {
  console.error('[BOOTSTRAP] Erro fatal:', error.message)
  process.exit(1)
})