const SUPPORTED_PERSISTENCE_PROFILES = Object.freeze([
  'development-rebuild',
  'test',
  'inventory-readonly',
])

const REQUIRED_PERSISTENCE_FIELDS = Object.freeze([
  'PERSISTENCE_PROFILE',
  'PERSISTENCE_INSTANCE_HOST',
  'PERSISTENCE_INSTANCE_PORT',
  'PERSISTENCE_INSTANCE_PROFILE',
  'BASELINE_DB_HOST',
  'BASELINE_DB_PORT',
  'BASELINE_DB_DATABASE',
  'PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE',
  'BASELINE_MIGRATIONS_PATH',
  'BASELINE_IDENTITY_CONFIG_PATH',
])

const CONNECTION_SECRET_FIELDS = Object.freeze([
  'BASELINE_DB_USERNAME',
  'BASELINE_DB_PASSWORD',
])

function normalizeRequiredString(value) {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizePort(value) {
  const normalized = normalizeRequiredString(value)
  if (!normalized || !/^\d+$/.test(normalized)) {
    return null
  }

  const port = Number(normalized)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

function pushRequiredFieldErrors(config, errors) {
  for (const field of REQUIRED_PERSISTENCE_FIELDS) {
    if (!config[field]) {
      errors.push(`Campo obrigatório ausente: ${field}`)
    }
  }
}

/**
 * Lê campos conhecidos de uma fonte de ambiente sem carregar arquivos, conectar recursos ou
 * validar regras de operação. A separação permite testar e validar a configuração em memória.
 *
 * @param {Record<string, unknown>} environment Fonte de variáveis, normalmente process.env.
 * @returns {Record<string, string | undefined>} Configuração bruta restrita aos campos conhecidos.
 */
export function readPersistenceConfig(environment = {}) {
  return {
    PERSISTENCE_PROFILE: environment.PERSISTENCE_PROFILE,
    NODE_ENV: environment.NODE_ENV,
    PERSISTENCE_INSTANCE_HOST: environment.PERSISTENCE_INSTANCE_HOST,
    PERSISTENCE_INSTANCE_PORT: environment.PERSISTENCE_INSTANCE_PORT,
    PERSISTENCE_INSTANCE_PROFILE: environment.PERSISTENCE_INSTANCE_PROFILE,
    BASELINE_DB_HOST: environment.BASELINE_DB_HOST,
    BASELINE_DB_PORT: environment.BASELINE_DB_PORT,
    BASELINE_DB_DATABASE: environment.BASELINE_DB_DATABASE,
    BASELINE_DB_USERNAME: environment.BASELINE_DB_USERNAME,
    BASELINE_DB_PASSWORD: environment.BASELINE_DB_PASSWORD,
    PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE: environment.PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE,
    BASELINE_MIGRATIONS_PATH: environment.BASELINE_MIGRATIONS_PATH,
    BASELINE_IDENTITY_CONFIG_PATH: environment.BASELINE_IDENTITY_CONFIG_PATH,
  }
}

/**
 * Valida configuração declarativa da fundação sem iniciar conexões, CLI, bootstrap ou migrations.
 * A presença de credenciais é exigida apenas quando a chamada futura declarar que precisa conectar.
 *
 * @param {Record<string, unknown>} rawConfig Configuração previamente lida.
 * @param {{ requiresConnectionCredentials?: boolean }} [options] Contexto puramente declarativo.
 * @returns {{ valid: boolean, errors: string[], warnings: string[], config: object }}
 */
export function validatePersistenceConfig(rawConfig, options = {}) {
  const requiresConnectionCredentials = options.requiresConnectionCredentials === true
  const config = {
    PERSISTENCE_PROFILE: normalizeRequiredString(rawConfig?.PERSISTENCE_PROFILE),
    NODE_ENV: normalizeRequiredString(rawConfig?.NODE_ENV),
    PERSISTENCE_INSTANCE_HOST: normalizeRequiredString(rawConfig?.PERSISTENCE_INSTANCE_HOST),
    PERSISTENCE_INSTANCE_PORT: normalizePort(rawConfig?.PERSISTENCE_INSTANCE_PORT),
    PERSISTENCE_INSTANCE_PROFILE: normalizeRequiredString(rawConfig?.PERSISTENCE_INSTANCE_PROFILE),
    BASELINE_DB_HOST: normalizeRequiredString(rawConfig?.BASELINE_DB_HOST),
    BASELINE_DB_PORT: normalizePort(rawConfig?.BASELINE_DB_PORT),
    BASELINE_DB_DATABASE: normalizeRequiredString(rawConfig?.BASELINE_DB_DATABASE),
    BASELINE_DB_USERNAME: normalizeRequiredString(rawConfig?.BASELINE_DB_USERNAME),
    BASELINE_DB_PASSWORD: normalizeRequiredString(rawConfig?.BASELINE_DB_PASSWORD),
    PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE: normalizeRequiredString(rawConfig?.PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE),
    BASELINE_MIGRATIONS_PATH: normalizeRequiredString(rawConfig?.BASELINE_MIGRATIONS_PATH),
    BASELINE_IDENTITY_CONFIG_PATH: normalizeRequiredString(rawConfig?.BASELINE_IDENTITY_CONFIG_PATH),
  }
  const errors = []
  const warnings = []

  pushRequiredFieldErrors(config, errors)

  if (config.PERSISTENCE_PROFILE && !SUPPORTED_PERSISTENCE_PROFILES.includes(config.PERSISTENCE_PROFILE)) {
    errors.push(`Perfil de persistência não reconhecido: ${config.PERSISTENCE_PROFILE}`)
  }

  if (!config.PERSISTENCE_INSTANCE_PORT && rawConfig?.PERSISTENCE_INSTANCE_PORT) {
    errors.push('PERSISTENCE_INSTANCE_PORT deve ser uma porta inteira entre 1 e 65535')
  }

  if (!config.BASELINE_DB_PORT && rawConfig?.BASELINE_DB_PORT) {
    errors.push('BASELINE_DB_PORT deve ser uma porta inteira entre 1 e 65535')
  }

  if (
    config.PERSISTENCE_PROFILE &&
    config.PERSISTENCE_INSTANCE_PROFILE &&
    config.PERSISTENCE_PROFILE !== config.PERSISTENCE_INSTANCE_PROFILE
  ) {
    errors.push('PERSISTENCE_INSTANCE_PROFILE deve corresponder a PERSISTENCE_PROFILE')
  }

  if (config.PERSISTENCE_PROFILE === 'development-rebuild' && config.NODE_ENV !== 'development') {
    errors.push('development-rebuild exige NODE_ENV explicitamente igual a development')
  }

  if (requiresConnectionCredentials) {
    for (const field of CONNECTION_SECRET_FIELDS) {
      if (!config[field]) {
        errors.push(`Campo obrigatório para conexão ausente: ${field}`)
      }
    }
  } else if (!config.BASELINE_DB_USERNAME || !config.BASELINE_DB_PASSWORD) {
    warnings.push('Credenciais de conexão não foram fornecidas; nenhuma conexão é autorizada por esta validação')
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    config,
  }
}

/**
 * Lê e valida em memória. Não carrega dotenv, não acessa o sistema de arquivos e não inicializa
 * nenhum recurso de trabalho.
 *
 * @param {Record<string, unknown>} environment Fonte de variáveis, normalmente process.env.
 * @param {{ requiresConnectionCredentials?: boolean }} [options] Contexto puramente declarativo.
 * @returns {{ valid: boolean, errors: string[], warnings: string[], config: object }}
 */
export function loadPersistenceConfig(environment = {}, options = {}) {
  return validatePersistenceConfig(readPersistenceConfig(environment), options)
}

/**
 * Produz uma visão segura para logs e diagnósticos sem expor credenciais ou segredos.
 *
 * @param {Record<string, unknown>} config Configuração bruta ou normalizada.
 * @returns {Record<string, unknown>} Configuração com segredos ocultos.
 */
export function redactPersistenceConfig(config = {}) {
  return {
    ...config,
    BASELINE_DB_USERNAME: config.BASELINE_DB_USERNAME ? '[REDACTED]' : undefined,
    BASELINE_DB_PASSWORD: config.BASELINE_DB_PASSWORD ? '[REDACTED]' : undefined,
  }
}

export { REQUIRED_PERSISTENCE_FIELDS, SUPPORTED_PERSISTENCE_PROFILES }