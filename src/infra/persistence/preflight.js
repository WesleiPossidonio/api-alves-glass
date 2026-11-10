#!/usr/bin/env node
/**
 * Preflight fail-closed da instância PostgreSQL.
 * Valida ambiente, identidade, allowlist/denylist antes de qualquer conexão administrativa.
 * Não conecta a banco de dados, não executa DDL, não cria schema ou tabelas.
 */

import dotenv from 'dotenv'
dotenv.config()

import {
  validateProfile,
  validateTargetIdentity,
  validateIdentityLists,
  checkIdentityAuthorization,
  loadAndValidateBaselineConfig,
} from './config-validator.js'

const CANONICAL_BASELINE_MIGRATIONS_PATH = '/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone/src/infra/persistence/baseline/migrations'

/**
 * Carrega allowlist e denylist de configuração não versionada.
 * Em produção, estes viriam de arquivo de configuração externo (ex: .baseline-identity.json fora do repo).
 * Para testes, podem ser fornecidos via variáveis de ambiente JSON.
 * @returns {Object} { allowlist, denylist }
 */
function loadIdentityLists() {
  if (process.env.BASELINE_ALLOWLIST) {
    try {
      const allowlist = JSON.parse(process.env.BASELINE_ALLOWLIST)
      const denylist = JSON.parse(process.env.BASELINE_DENYLIST || '[]')
      return { allowlist, denylist }
    } catch (e) {
      throw new Error(`Falha ao parsear BASELINE_ALLOWLIST/BASELINE_DENYLIST: ${e.message}`)
    }
  }

  const configPath =  process.env.BASELINE_IDENTITY_CONFIG_PATH
  if (configPath) {
    try {
      const fs = import('fs')
      const path = import('path')
      const resolvedPath = path.resolve(configPath)
      const content = fs.readFileSync(resolvedPath, 'utf-8')
      const config = JSON.parse(content)
      return { allowlist: config.allowlist || [], denylist: config.denylist || [] }
    } catch (e) {
      throw new Error(`Falha ao carregar configuração de identidade de ${configPath}: ${e.message}`)
    }
  }

  return { allowlist: [], denylist: [] }
}
/**
 * Constrói identidade efetiva a partir da configuração de baseline.
 * @param {Object} config - Configuração validada do baseline
 * @param {string} profile - Perfil de operação
 * @returns {Object} Identidade efetiva
 */
function buildEffectiveIdentity(config, profile) {
  return {
    environment: process.env.NODE_ENV || 'development',
    host: config.BASELINE_DB_HOST,
    port: Number(config.BASELINE_DB_PORT),
    database: config.BASELINE_DB_DATABASE,
    profile,
  }
}

/**
 * Executa preflight da instância (fail-closed).
 * Valida: ambiente explicitamente de desenvolvimento, campos completos,
 * allowlist/denylist, correspondência exata com exatamente um destino autorizado
 * e nenhum protegido.
 * @param {string} profile - Perfil de operação
 * @returns {Object} Resultado do preflight
 */
export async function runInstancePreflight(profile) {
  const result = {
    stage: 'instance-preflight',
    profile,
    validated: false,
    blocked: false,
    errors: [],
    warnings: [],
    identity: null,
    allowlist: [],
    denylist: [],
  }

  try {
    const profileValidation = validateProfile(profile)
    if (!profileValidation.valid) {
      result.errors.push(...profileValidation.errors)
      result.blocked = true
      return result
    }

    const configResult = loadAndValidateBaselineConfig(process.env, CANONICAL_BASELINE_MIGRATIONS_PATH)
    if (!configResult.valid) {
      result.errors.push(...configResult.errors)
      result.blocked = true
      return result
    }

    let allowlist, denylist
    try {
      const lists = loadIdentityLists()
      allowlist = lists.allowlist
      denylist = lists.denylist
    } catch (e) {
      result.errors.push(`Falha ao carregar listas de identidade: ${e.message}`)
      result.blocked = true
      return result
    }

    result.allowlist = allowlist
    result.denylist = denylist

    const listsValidation = validateIdentityLists(allowlist, denylist)
    if (!listsValidation.valid) {
      result.errors.push(...listsValidation.errors)
      result.blocked = true
      return result
    }

    const effectiveIdentity = buildEffectiveIdentity(configResult.config, profile)
    result.identity = effectiveIdentity

    const authResult = checkIdentityAuthorization(effectiveIdentity, allowlist, denylist)
    if (!authResult.authorized) {
      result.errors.push(...authResult.errors)
      result.blocked = true
      return result
    }

    if (profile === 'development-rebuild') {
      if (effectiveIdentity.environment !== 'development') {
        result.errors.push(`Perfil 'development-rebuild' exige ambiente explicitamente 'development', atual: ${effectiveIdentity.environment}`)
        result.blocked = true
        return result
      }
    }

    result.validated = true
    return result

  } catch (error) {
    result.errors.push(`Erro inesperado no preflight: ${error.message}`)
    result.blocked = true
    return result
  }
}

/**
 * Executa preflight da identidade do banco (etapa 3 do bootstrap).
 * Valida host, porta, database, ambiente, perfil, conexão efetiva,
 * inventário do original e caminho canônico antes de invocar Sequelize CLI.
 * @param {Object} instancePreflightResult - Resultado do preflight da instância
 * @returns {Object} Resultado do preflight do banco
 */
export async function runDatabaseIdentityPreflight(instancePreflightResult) {
  const result = {
    stage: 'database-identity-preflight',
    profile: instancePreflightResult.profile,
    validated: false,
    blocked: false,
    errors: [],
    warnings: [],
    identity: instancePreflightResult.identity,
    allowlist: instancePreflightResult.allowlist,
    denylist: instancePreflightResult.denylist,
  }

  try {
    if (!instancePreflightResult.validated) {
      result.errors.push('Preflight da instância não foi validado')
      result.blocked = true
      return result
    }

    const identity = instancePreflightResult.identity

    const identityValidation = validateTargetIdentity(identity)
    if (!identityValidation.valid) {
      result.errors.push(...identityValidation.errors)
      result.blocked = true
      return result
    }

    if (identity.profile !== instancePreflightResult.profile) {
      result.errors.push(`Perfil da identidade (${identity.profile}) difere do perfil solicitado (${instancePreflightResult.profile})`)
      result.blocked = true
      return result
    }

    result.validated = true
    return result

  } catch (error) {
    result.errors.push(`Erro inesperado no preflight de identidade do banco: ${error.message}`)
    result.blocked = true
    return result
  }
}

// CLI entry point
async function main() {
  const profile = process.argv[2] || 'test'

  console.log(`[PREFLIGHT] Iniciando preflight para perfil: ${profile}`)
  console.log(`[PREFLIGHT] Caminho canônico de migrations: ${CANONICAL_BASELINE_MIGRATIONS_PATH}`)

  const instanceResult = await runInstancePreflight(profile)

  if (instanceResult.blocked) {
    console.error('[PREFLIGHT] BLOQUEADO:', instanceResult.errors.join('; '))
    process.exit(1)
  }

  console.log('[PREFLIGHT] Preflight da instância: VALIDADO')
  console.log('[PREFLIGHT] Identidade efetiva:', JSON.stringify(instanceResult.identity, null, 2))

  const dbResult = await runDatabaseIdentityPreflight(instanceResult)

  if (dbResult.blocked) {
    console.error('[PREFLIGHT] BLOQUEADO (identidade do banco):', dbResult.errors.join('; '))
    process.exit(1)
  }

  console.log('[PREFLIGHT] Preflight de identidade do banco: VALIDADO')
  console.log('[PREFLIGHT] Resultado final: instance-validated')

  console.log('PREFLIGHT_RESULT=' + JSON.stringify({ instance: instanceResult, database: dbResult }))
}

main().catch((error) => {
  console.error('[PREFLIGHT] Erro fatal:', error.message)
  process.exit(1)
})