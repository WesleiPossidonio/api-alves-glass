const IDENTITY_FIELDS = Object.freeze([
  'environment',
  'host',
  'port',
  'database',
  'profile',
])

function normalizeString(value, field, errors, { lowerCase = false } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`Campo obrigatório da identidade ausente ou inválido: ${field}`)
    return null
  }

  const normalized = value.trim()
  return lowerCase ? normalized.toLowerCase() : normalized
}

function normalizePort(value, errors) {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^\d+$/.test(raw)) {
    errors.push('Campo obrigatório da identidade ausente ou inválido: port')
    return null
  }

  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('Porta da identidade deve ser um inteiro entre 1 e 65535')
    return null
  }

  return port
}

function identityKey(identity) {
  return IDENTITY_FIELDS.map(field => String(identity[field])).join('\u0000')
}

function entriesWithSameIdentity(identity, entries) {
  const key = identityKey(identity)
  return entries.filter(entry => identityKey(entry) === key)
}

/**
 * Normaliza uma identidade para uma comparação controlada e exata. Ambiente, host e perfil são
 * case-insensitive por definição operacional; database preserva case após trim.
 *
 * @param {Record<string, unknown>} input Identidade declarada ou efetiva.
 * @returns {{ valid: boolean, errors: string[], identity: object | null }}
 */
export function normalizeIdentity(input) {
  const errors = []
  const identity = {
    environment: normalizeString(input?.environment, 'environment', errors, { lowerCase: true }),
    host: normalizeString(input?.host, 'host', errors, { lowerCase: true }),
    port: normalizePort(input?.port, errors),
    database: normalizeString(input?.database, 'database', errors),
    profile: normalizeString(input?.profile, 'profile', errors, { lowerCase: true }),
  }

  return {
    valid: errors.length === 0,
    errors,
    identity: errors.length === 0 ? Object.freeze(identity) : null,
  }
}

/**
 * Compara identidades somente depois de ambas passarem pela normalização controlada.
 *
 * @param {Record<string, unknown>} left Primeira identidade.
 * @param {Record<string, unknown>} right Segunda identidade.
 * @returns {{ matches: boolean, errors: string[] }}
 */
export function identitiesMatchExactly(left, right) {
  const normalizedLeft = normalizeIdentity(left)
  const normalizedRight = normalizeIdentity(right)
  const errors = [...normalizedLeft.errors, ...normalizedRight.errors]

  if (errors.length > 0) {
    return { matches: false, errors }
  }

  return {
    matches: identityKey(normalizedLeft.identity) === identityKey(normalizedRight.identity),
    errors: [],
  }
}

/**
 * Valida listas de autorização sem usar estado externo nem assumir que algum preflight anterior
 * foi executado. A referência protegida deve apontar exatamente para uma identidade da denylist.
 *
 * @param {{ allowlist?: unknown, denylist?: unknown, protectedOriginalReference?: unknown }} input Listas e referência do original.
 * @returns {{ valid: boolean, errors: string[], allowlist: object[], denylist: object[] }}
 */
export function validateAuthorizationLists(input = {}) {
  const errors = []
  const protectedOriginalReference = normalizeString(
    input.protectedOriginalReference,
    'protectedOriginalReference',
    errors
  )

  if (!Array.isArray(input.allowlist) || input.allowlist.length === 0) {
    errors.push('Allowlist de destinos autorizados é obrigatória e não pode estar vazia')
  }

  if (!Array.isArray(input.denylist) || input.denylist.length === 0) {
    errors.push('Denylist de identidades protegidas é obrigatória e não pode estar vazia')
  }

  const allowlist = []
  const denylist = []

  if (Array.isArray(input.allowlist)) {
    input.allowlist.forEach((entry, index) => {
      const normalized = normalizeIdentity(entry)
      if (!normalized.valid) {
        errors.push(`Allowlist[${index}]: ${normalized.errors.join('; ')}`)
        return
      }
      allowlist.push(normalized.identity)
    })
  }

  if (Array.isArray(input.denylist)) {
    input.denylist.forEach((entry, index) => {
      const normalized = normalizeIdentity(entry)
      if (!normalized.valid) {
        errors.push(`Denylist[${index}]: ${normalized.errors.join('; ')}`)
        return
      }

      const reference = normalizeString(entry?.reference, `denylist[${index}].reference`, errors)
      denylist.push(Object.freeze({ ...normalized.identity, reference }))
    })
  }

  const allowlistKeys = new Set()
  for (const entry of allowlist) {
    const key = identityKey(entry)
    if (allowlistKeys.has(key)) {
      errors.push('Allowlist contém identidades duplicadas ou ambíguas')
    }
    allowlistKeys.add(key)
  }

  const denylistKeys = new Set()
  for (const entry of denylist) {
    const key = identityKey(entry)
    if (denylistKeys.has(key)) {
      errors.push('Denylist contém identidades duplicadas ou ambíguas')
    }
    denylistKeys.add(key)

    if (allowlistKeys.has(key)) {
      errors.push('Uma identidade não pode constar simultaneamente na allowlist e na denylist')
    }
  }

  if (protectedOriginalReference) {
    const protectedOriginalEntries = denylist.filter(entry => entry.reference === protectedOriginalReference)
    if (protectedOriginalEntries.length !== 1) {
      errors.push('A referência protegida do original deve corresponder a exatamente uma identidade na denylist')
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    allowlist: Object.freeze(allowlist),
    denylist: Object.freeze(denylist),
  }
}

/**
 * Autoriza uma identidade efetiva somente se as listas válidas contiverem exatamente um destino
 * autorizado, nenhuma identidade protegida e a referência protegida do original estiver presente.
 * Nenhuma propriedade como `validated: true` é aceita como substituta dessas verificações.
 *
 * @param {Record<string, unknown>} effectiveIdentity Identidade efetiva declarada para validação futura.
 * @param {{ allowlist?: unknown, denylist?: unknown, protectedOriginalReference?: unknown }} authorizationConfig Listas e referência protegida.
 * @returns {{ authorized: boolean, blocked: boolean, errors: string[], identity: object | null, matchedDestination: object | null }}
 */
export function authorizeTargetIdentity(effectiveIdentity, authorizationConfig = {}) {
  const listValidation = validateAuthorizationLists(authorizationConfig)
  const normalizedIdentity = normalizeIdentity(effectiveIdentity)
  const errors = [...listValidation.errors, ...normalizedIdentity.errors]

  if (errors.length > 0) {
    return {
      authorized: false,
      blocked: true,
      errors,
      identity: null,
      matchedDestination: null,
    }
  }

  const protectedMatches = entriesWithSameIdentity(normalizedIdentity.identity, listValidation.denylist)
  if (protectedMatches.length > 0) {
    return {
      authorized: false,
      blocked: true,
      errors: ['A identidade efetiva corresponde a uma identidade protegida na denylist'],
      identity: normalizedIdentity.identity,
      matchedDestination: null,
    }
  }

  const authorizedMatches = entriesWithSameIdentity(normalizedIdentity.identity, listValidation.allowlist)
  if (authorizedMatches.length !== 1) {
    return {
      authorized: false,
      blocked: true,
      errors: [
        authorizedMatches.length === 0
          ? 'A identidade efetiva não corresponde a nenhum destino autorizado na allowlist'
          : 'A identidade efetiva corresponde a mais de um destino autorizado na allowlist',
      ],
      identity: normalizedIdentity.identity,
      matchedDestination: null,
    }
  }

  return {
    authorized: true,
    blocked: false,
    errors: [],
    identity: normalizedIdentity.identity,
    matchedDestination: authorizedMatches[0],
  }
}