/**
 * Validador de configuração da fundação de persistência.
 * Valida configuração sem iniciar recursos de trabalho ou conectar a banco de dados.
 */

const REQUIRED_BASELINE_FIELDS = [
  'BASELINE_DB_HOST',
  'BASELINE_DB_PORT',
  'BASELINE_DB_USERNAME',
  'BASELINE_DB_PASSWORD',
  'BASELINE_DB_DATABASE',
]

const VALID_PROFILES = [
  'development-rebuild',
  'test',
  'inventory-readonly',
  'data-preservation',
]

const REQUIRED_IDENTITY_FIELDS = [
  'environment',
  'host',
  'port',
  'database',
  'profile',
]

/**
 * Valida se a configuração do baseline está completa.
 * @param {Object} config - Configuração carregada
 * @returns {Object} Resultado da validação
 */
export function validateBaselineConfig(config) {
  const errors = []
  const warnings = []

  for (const field of REQUIRED_BASELINE_FIELDS) {
    if (!config[field]) {
      errors.push(`Campo obrigatório ausente: ${field}`)
    }
  }

  if (config.BASELINE_DB_PORT) {
    const port = Number(config.BASELINE_DB_PORT)
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      errors.push(`BASELINE_DB_PORT deve ser um número entre 1 e 65535`)
    }
  }

  if (config.migrationStorageTableSchema !== 'baseline_meta') {
    errors.push(`migrationStorageTableSchema deve ser 'baseline_meta', recebido: ${config.migrationStorageTableSchema}`)
  }

  if (config.migrationStorageTableName !== 'SequelizeMetaBaseline') {
    errors.push(`migrationStorageTableName deve ser 'SequelizeMetaBaseline', recebido: ${config.migrationStorageTableName}`)
  }

  if (config.migrationStorage !== 'sequelize') {
    errors.push(`migrationStorage deve ser 'sequelize', recebido: ${config.migrationStorage}`)
  }

  return { valid: errors.length === 0, errors, warnings }
}
/**
 * Valida perfil de operação.
 * @param {string} profile - Perfil de operação
 * @returns {Object} Resultado da validação
 */
export function validateProfile(profile) {
  const errors = []

  if (!profile) {
    errors.push('Perfil de operação é obrigatório')
  } else if (!VALID_PROFILES.includes(profile)) {
    errors.push(`Perfil inválido: ${profile}. Perfis válidos: ${VALID_PROFILES.join(', ')}`)
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Valida identidade completa de destino.
 * @param {Object} identity - Identidade do destino
 * @returns {Object} Resultado da validação
 */
export function validateTargetIdentity(identity) {
  const errors = []

  if (!identity) {
    errors.push('Identidade do destino é obrigatória')
    return { valid: false, errors }
  }

  for (const field of REQUIRED_IDENTITY_FIELDS) {
    if (!identity[field]) {
      errors.push(`Campo obrigatório da identidade ausente: ${field}`)
    }
  }

  if (identity.port) {
    const port = Number(identity.port)
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      errors.push(`Porta deve ser um número entre 1 e 65535`)
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Valida caminho de migrations.
 * @param {string} migrationsPath - Caminho absoluto das migrations
 * @param {string} canonicalPath - Caminho canônico esperado
 * @returns {Object} Resultado da validação
 */
export function validateMigrationsPath(migrationsPath, canonicalPath) {
  const errors = []
  const warnings = []

  if (!migrationsPath) {
    errors.push('Caminho de migrations é obrigatório')
    return { valid: false, errors }
  }

  const normalizedPath = migrationsPath.replace(/\/+$/, '')
  const normalizedCanonical = canonicalPath.replace(/\/+$/, '')

  if (normalizedPath !== normalizedCanonical) {
    errors.push(`Caminho de migrations não corresponde ao canônico. Esperado: ${canonicalPath}, Recebido: ${migrationsPath}`)
  }

  return { valid: errors.length === 0, errors }
}
/**
 * Valida allowlist e denylist de identidades.
 * @param {Array} allowlist - Lista de destinos autorizados
 * @param {Array} denylist - Lista de identidades protegidas
 * @returns {Object} Resultado da validação
 */
export function validateIdentityLists(allowlist, denylist) {
  const errors = []
  const warnings = []

  if (!allowlist || !Array.isArray(allowlist) || allowlist.length === 0) {
    errors.push('Allowlist de destinos autorizados é obrigatória e não pode estar vazia')
  } else {
    for (let i = 0; i < allowlist.length; i++) {
      const entry = allowlist[i]
      const identityErrors = validateTargetIdentity(entry).errors
      if (identityErrors.length > 0) {
        errors.push(`Allowlist[${i}]: ${identityErrors.join('; ')}`)
      }
    }
  }

  if (!denylist || !Array.isArray(denylist)) {
    errors.push('Denylist de identidades protegidas é obrigatória (pode ser array vazio)')
  } else {
    for (let i = 0; i < denylist.length; i++) {
      const entry = denylist[i]
      const identityErrors = validateTargetIdentity(entry).errors
      if (identityErrors.length > 0) {
        errors.push(`Denylist[${i}]: ${identityErrors.join('; ')}`)
      }
    }
  }

  if (allowlist && denylist) {
    for (const allowed of allowlist) {
      for (const denied of denylist) {
        if (identitiesMatch(allowed, denied)) {
          errors.push(`Identidade aparece tanto na allowlist quanto na denylist: ${JSON.stringify(allowed)}`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/**
 * Compara duas identidades para verificação de correspondência exata.
 * @param {Object} a - Primeira identidade
 * @param {Object} b - Segunda identidade
 * @returns {boolean}
 */
export function identitiesMatch(a, b) {
  return (
    a.environment === b.environment &&
    a.host === b.host &&
    a.port === b.port &&
    a.database === b.database &&
    a.profile === b.profile
  )
}

/**
 * Verifica se uma identidade corresponde a exatamente uma entrada na allowlist
 * e a nenhuma entrada na denylist.
 * @param {Object} identity - Identidade efetiva a verificar
 * @param {Array} allowlist - Lista de destinos autorizados
 * @param {Array} denylist - Lista de identidades protegidas
 * @returns {Object} Resultado da verificação
 */
export function checkIdentityAuthorization(identity, allowlist, denylist) {
  const errors = []

  if (!identity) {
    errors.push('Identidade efetiva é obrigatória para autorização')
    return { authorized: false, errors, matchedAllowlist: null }
  }

  for (const denied of denylist || []) {
    if (identitiesMatch(identity, denied)) {
      errors.push(`Identidade efetiva coincide com identidade protegida na denylist: ${JSON.stringify(denied)}`)
      return { authorized: false, errors, matchedAllowlist: null }
    }
  }

  let matchCount = 0
  let matchedEntry = null

  for (const allowed of allowlist || []) {
    if (identitiesMatch(identity, allowed)) {
      matchCount++
      matchedEntry = allowed
    }
  }

  if (matchCount === 0) {
    errors.push('Identidade efetiva não corresponde a nenhum destino autorizado na allowlist')
  } else if (matchCount > 1) {
    errors.push(`Identidade efetiva corresponde a ${matchCount} destinos na allowlist (ambiguidade)`)
  }

  return { authorized: errors.length === 0, errors, matchedAllowlist: matchedEntry }
}

/**
 * Carrega e valida configuração completa do baseline.
 * @param {Object} env - Variáveis de ambiente (process.env)
 * @param {string} canonicalMigrationsPath - Caminho canônico das migrations do baseline
 * @returns {Object} Configuração validada e resultados
 */
export function loadAndValidateBaselineConfig(env, canonicalMigrationsPath) {
  const config = {
    BASELINE_DB_HOST: env.BASELINE_DB_HOST,
    BASELINE_DB_PORT: env.BASELINE_DB_PORT,
    BASELINE_DB_USERNAME: env.BASELINE_DB_USERNAME,
    BASELINE_DB_PASSWORD: env.BASELINE_DB_PASSWORD,
    BASELINE_DB_DATABASE: env.BASELINE_DB_DATABASE,
    migrationStorage: 'sequelize',
    migrationStorageTableName: 'SequelizeMetaBaseline',
    migrationStorageTableSchema: 'baseline_meta',
  }

  const configValidation = validateBaselineConfig(config)
  const pathValidation = validateMigrationsPath(env.BASELINE_MIGRATIONS_PATH, canonicalMigrationsPath)

  const allErrors = [...configValidation.errors, ...pathValidation.errors]
  const allWarnings = [...configValidation.warnings, ...pathValidation.warnings]

  return { config, valid: allErrors.length === 0, errors: allErrors, warnings: allWarnings }
}