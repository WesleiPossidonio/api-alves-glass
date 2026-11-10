import { createHash, verify } from 'node:crypto'
import { identitiesMatchExactly, normalizeIdentity } from './target-identity.js'

const ATTESTATION_SOURCE = 'approved-endpoint-attestation'
const LOCAL_DOCKER_SESSION_SOURCE = 'local-docker-session-verification'
const REQUIRED_DOCKER_FIELDS = Object.freeze(['containerId', 'networkId', 'networkEndpointId', 'networkAddress', 'service'])
const LOCAL_TEST_EXPECTATION = Object.freeze({
  containerName: 'postgres-alves-glass-test',
  service: 'postgres-test',
  composeProject: 'api-alves-glass-clone',
  networkName: 'api-alves-glass-clone_persistence-test-network',
  host: 'postgres-test',
  port: 5432,
  database: 'alvesglass_test',
  profile: 'test',
})

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value

  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalize(value[key])
    return result
  }, {})
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function withoutFields(attestation, fields) {
  return Object.fromEntries(Object.entries(attestation).filter(([key]) => !fields.has(key)))
}

function fingerprintPayload(attestation) {
  return withoutFields(attestation, new Set(['fingerprint', 'signature']))
}

function signedPayload(attestation) {
  return withoutFields(attestation, new Set(['signature']))
}

function hasTrustedKey(trustedPublicKeys, keyId) {
  return trustedPublicKeys && typeof trustedPublicKeys === 'object' && !Array.isArray(trustedPublicKeys) && trustedPublicKeys[keyId]
}

function validateExpiration(attestation, now) {
  if (!isNonEmptyString(attestation.issuedAt) || !isNonEmptyString(attestation.expiresAt)) {
    return ['Atestado deve informar issuedAt e expiresAt']
  }

  const issuedAt = Date.parse(attestation.issuedAt)
  const expiresAt = Date.parse(attestation.expiresAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    return ['Janela temporal do atestado é inválida']
  }
  if (now < issuedAt || now >= expiresAt) {
    return ['Atestado de endpoint está expirado ou ainda não é válido']
  }
  return []
}

function validateSessionBinding(attestation, serverSession) {
  if (!serverSession || typeof serverSession !== 'object') {
    return ['Sessão PostgreSQL observada é obrigatória para validar o atestado']
  }
  if (!isNonEmptyString(serverSession.serverAddress) || !Number.isInteger(serverSession.serverPort)) {
    return ['Sessão PostgreSQL não informou endereço e porta verificáveis do servidor']
  }
  if (!attestation.postgres || attestation.postgres.serverAddress !== serverSession.serverAddress || attestation.postgres.serverPort !== serverSession.serverPort) {
    return ['Atestado não corresponde ao endereço e porta da sessão PostgreSQL conectada']
  }
  if (attestation.docker?.networkAddress !== serverSession.serverAddress) {
    return ['Atestado não vincula o endpoint Docker ao endereço observado pela sessão PostgreSQL']
  }
  return []
}

/**
 * Verifica um atestado externo, assinado e de curta duração para o endpoint isolado de teste.
 * Não acessa Docker, não gera chaves e não transforma configuração declarativa em prova física.
 *
 * @param {{ attestation?: object, trustedPublicKeys?: Record<string, string|object>, expectedTarget?: object, expectedNonce?: string, serverSession?: { serverAddress?: string, serverPort?: number }, now?: number }} input Dados do atestado e vínculos observados pela sessão.
 * @returns {{ verified: boolean, errors: string[], physicalInstance: object | null }} Resultado fail-closed da verificação.
 */
export function verifyTestEndpointAttestation(input = {}) {
  const attestation = input.attestation
  const errors = []
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return { verified: false, errors: ['Atestado externo estruturado de endpoint é obrigatório'], physicalInstance: null }
  }

  const target = normalizeIdentity(input.expectedTarget)
  const attestedTarget = normalizeIdentity(attestation.declaredTarget)
  if (!target.valid || !attestedTarget.valid || !identitiesMatchExactly(target.identity, attestedTarget.identity).matches) {
    errors.push('Atestado não está vinculado exatamente ao destino autorizado')
  }
  if (attestation.profile !== 'test' || attestedTarget.identity?.profile !== 'test') {
    errors.push('Atestado é aceito exclusivamente para o perfil test')
  }
  if (!isNonEmptyString(input.expectedNonce) || attestation.nonce !== input.expectedNonce) {
    errors.push('Nonce do atestado não corresponde à execução atual')
  }
  errors.push(...validateExpiration(attestation, input.now ?? Date.now()))

  for (const field of REQUIRED_DOCKER_FIELDS) {
    if (!isNonEmptyString(attestation.docker?.[field])) errors.push(`Atestado deve informar docker.${field}`)
  }

  if (!isNonEmptyString(attestation.postgres?.serverAddress) || !Number.isInteger(attestation.postgres?.serverPort)) {
    errors.push('Atestado deve informar endpoint PostgreSQL verificável')
  }
  errors.push(...validateSessionBinding(attestation, input.serverSession))

  const signature = attestation.signature
  if (!signature || signature.algorithm !== 'ed25519' || !isNonEmptyString(signature.keyId) || !isNonEmptyString(signature.value)) {
    errors.push('Atestado deve conter assinatura Ed25519 com keyId confiável')
  } else if (!hasTrustedKey(input.trustedPublicKeys, signature.keyId)) {
    errors.push('Chave pública do atestado não é confiável')
  } else {
    const expectedFingerprint = createHash('sha256').update(canonicalJson(fingerprintPayload(attestation))).digest('hex')
    if (attestation.fingerprint !== expectedFingerprint) {
      errors.push('Fingerprint do atestado não corresponde ao conteúdo assinado')
    }
    try {
      const signatureValid = verify(
        null,
        Buffer.from(canonicalJson(signedPayload(attestation))),
        input.trustedPublicKeys[signature.keyId],
        Buffer.from(signature.value, 'base64'),
      )
      if (!signatureValid) errors.push('Assinatura do atestado é inválida')
    } catch {
      errors.push('Assinatura ou chave pública do atestado é inválida')
    }
  }

  if (errors.length > 0) return { verified: false, errors: Object.freeze(errors), physicalInstance: null }

  return Object.freeze({
    verified: true,
    errors: Object.freeze([]),
    physicalInstance: Object.freeze({
      verified: true,
      source: ATTESTATION_SOURCE,
      fingerprint: attestation.fingerprint,
      containerId: attestation.docker.containerId,
      networkId: attestation.docker.networkId,
      networkEndpointId: attestation.docker.networkEndpointId,
    }),
  })
}

/**
 * Valida a alternativa operacional local aprovada para `test`: a inspeção Docker é coletada fora
 * do processo consumidor, em contexto confiável, e é correlacionada com a sessão PostgreSQL já
 * autenticada. Não acessa Docker, não aceita localhost e não substitui o atestado Ed25519 fora do
 * profile local de testes.
 *
 * @param {{ dockerEvidence?: object, expectedTarget?: object, serverSession?: { serverAddress?: string, serverPort?: number } }} input Evidência da inspeção confiável e fatos da sessão autenticada.
 * @returns {{ verified: boolean, errors: readonly string[], physicalInstance: object | null }} Resultado fail-closed.
 */
export function verifyLocalDockerSessionIdentity(input = {}) {
  const evidence = input.dockerEvidence
  const errors = []
  const target = normalizeIdentity(input.expectedTarget)
  const expected = normalizeIdentity({
    environment: 'test',
    host: LOCAL_TEST_EXPECTATION.host,
    port: LOCAL_TEST_EXPECTATION.port,
    database: LOCAL_TEST_EXPECTATION.database,
    profile: LOCAL_TEST_EXPECTATION.profile,
  })

  if (!target.valid || !expected.valid || !identitiesMatchExactly(target.identity, expected.identity).matches) {
    errors.push('Verificação Docker+sessõo local aceita exclusivamente test/postgres-test:5432/alvesglass_test')
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return Object.freeze({ verified: false, errors: Object.freeze(['Evidência estruturada de inspeção Docker local é obrigatória']), physicalInstance: null })
  }
  if (evidence.containerName !== LOCAL_TEST_EXPECTATION.containerName || evidence.service !== LOCAL_TEST_EXPECTATION.service || evidence.composeProject !== LOCAL_TEST_EXPECTATION.composeProject) {
    errors.push('Inspeção Docker não corresponde ao container Compose local autorizado de teste')
  }
  if (evidence.networkName !== LOCAL_TEST_EXPECTATION.networkName) {
    errors.push('Inspeção Docker não corresponde à rede local autorizada de teste')
  }
  for (const field of ['containerId', 'networkId', 'networkEndpointId', 'networkAddress']) {
    if (!isNonEmptyString(evidence[field])) errors.push(`Inspeção Docker deve informar ${field}`)
  }
  if (!input.serverSession || !isNonEmptyString(input.serverSession.serverAddress) || !Number.isInteger(input.serverSession.serverPort)) {
    errors.push('Sessão PostgreSQL deve informar endereço e porta do servidor')
  } else if (input.serverSession.serverAddress !== evidence.networkAddress || input.serverSession.serverPort !== LOCAL_TEST_EXPECTATION.port) {
    errors.push('Sessão PostgreSQL não corresponde ao endpoint Docker inspecionado')
  }

  if (errors.length > 0) return Object.freeze({ verified: false, errors: Object.freeze(errors), physicalInstance: null })
  const fingerprint = createHash('sha256').update(canonicalJson({
    containerId: evidence.containerId,
    networkId: evidence.networkId,
    networkEndpointId: evidence.networkEndpointId,
    networkAddress: evidence.networkAddress,
    service: evidence.service,
    target: target.identity,
  })).digest('hex')
  return Object.freeze({
    verified: true,
    errors: Object.freeze([]),
    physicalInstance: Object.freeze({
      verified: true,
      source: LOCAL_DOCKER_SESSION_SOURCE,
      fingerprint,
      containerId: evidence.containerId,
      networkId: evidence.networkId,
      networkEndpointId: evidence.networkEndpointId,
    }),
  })
}

export { ATTESTATION_SOURCE, LOCAL_DOCKER_SESSION_SOURCE, LOCAL_TEST_EXPECTATION }
