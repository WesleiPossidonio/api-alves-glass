import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { verifyLocalDockerSessionIdentity, verifyTestEndpointAttestation } from '../../../src/infrastructure/persistence/test-endpoint-attestation.js'

const target = Object.freeze({ environment: 'test', host: 'postgres-test', port: 5432, database: 'alvesglass_test', profile: 'test' })
const keys = generateKeyPairSync('ed25519')
const now = Date.parse('2026-11-09T12:00:00.000Z')

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => ({ ...result, [key]: canonicalize(value[key]) }), {})
}

function canonicalJson(value) { return JSON.stringify(canonicalize(value)) }

function createAttestation(overrides = {}) {
  const base = {
    version: 1,
    profile: 'test',
    issuedAt: '2026-11-09T11:59:00.000Z',
    expiresAt: '2026-11-09T12:05:00.000Z',
    nonce: 'execution-nonce',
    declaredTarget: target,
    docker: { containerId: 'container-id', networkId: 'network-id', networkEndpointId: 'endpoint-id', networkAddress: '172.24.0.2', service: 'postgres-test' },
    postgres: { serverAddress: '172.24.0.2', serverPort: 5432 },
    ...overrides,
  }
  const fingerprint = createHash('sha256').update(canonicalJson(base)).digest('hex')
  const signed = { ...base, fingerprint }
  return { ...signed, signature: { algorithm: 'ed25519', keyId: 'test-key', value: sign(null, Buffer.from(canonicalJson(signed)), keys.privateKey).toString('base64') } }
}

function verify(attestation, overrides = {}) {
  return verifyTestEndpointAttestation({
    attestation,
    trustedPublicKeys: { 'test-key': keys.publicKey },
    expectedTarget: target,
    expectedNonce: 'execution-nonce',
    serverSession: { serverAddress: '172.24.0.2', serverPort: 5432 },
    now,
    ...overrides,
  })
}

test('verifica atestado Ed25519 confiável vinculado ao destino, container, rede e sessão', () => {
  const result = verify(createAttestation())
  assert.equal(result.verified, true)
  assert.equal(result.physicalInstance.source, 'approved-endpoint-attestation')
  assert.equal(result.physicalInstance.containerId, 'container-id')
})

test('rejeita assinatura, chave, nonce, expiração, endpoint e destino divergentes', () => {
  const valid = createAttestation()
  const cases = [
    verify({ ...valid, signature: { ...valid.signature, value: Buffer.from('invalid').toString('base64') } }),
    verify(valid, { trustedPublicKeys: {} }),
    verify(valid, { expectedNonce: 'other-nonce' }),
    verify(createAttestation({ expiresAt: '2026-11-09T11:59:30.000Z' })),
    verify(valid, { serverSession: { serverAddress: '172.24.0.99', serverPort: 5432 } }),
    verify(createAttestation({ declaredTarget: { ...target, database: 'other' } })),
  ]
  for (const result of cases) assert.equal(result.verified, false)
})

test('não aceita snapshot declarativo sem assinatura verificável nem acessa Docker', async () => {
  const result = verifyTestEndpointAttestation({ attestation: { declaredTarget: target }, expectedTarget: target, expectedNonce: 'x', serverSession: {} })
  assert.equal(result.verified, false)
  const module = await import('../../../src/infrastructure/persistence/test-endpoint-attestation.js')
  assert.equal(typeof module.verifyTestEndpointAttestation, 'function')
})

test('aceita exclusivamente a verificação local Docker+sessõo do destino test aprovado', () => {
  const result = verifyLocalDockerSessionIdentity({
    expectedTarget: target,
    dockerEvidence: {
      containerName: 'postgres-alves-glass-test', containerId: 'container-id', service: 'postgres-test', composeProject: 'api-alves-glass-clone',
      networkName: 'api-alves-glass-clone_persistence-test-network', networkId: 'network-id', networkEndpointId: 'endpoint-id', networkAddress: '172.19.0.2',
    },
    serverSession: { serverAddress: '172.19.0.2', serverPort: 5432 },
  })
  assert.equal(result.verified, true)
  assert.equal(result.physicalInstance.source, 'local-docker-session-verification')
})

test('bloqueia verificação local com destino, Docker ou sessão divergentes', () => {
  const valid = {
    expectedTarget: target,
    dockerEvidence: {
      containerName: 'postgres-alves-glass-test', containerId: 'container-id', service: 'postgres-test', composeProject: 'api-alves-glass-clone',
      networkName: 'api-alves-glass-clone_persistence-test-network', networkId: 'network-id', networkEndpointId: 'endpoint-id', networkAddress: '172.19.0.2',
    },
    serverSession: { serverAddress: '172.19.0.2', serverPort: 5432 },
  }
  for (const input of [
    { ...valid, expectedTarget: { ...target, host: 'localhost', port: 5434 } },
    { ...valid, dockerEvidence: { ...valid.dockerEvidence, containerName: 'other' } },
    { ...valid, dockerEvidence: { ...valid.dockerEvidence, networkName: 'other-network' } },
    { ...valid, serverSession: { serverAddress: '172.19.0.99', serverPort: 5432 } },
  ]) assert.equal(verifyLocalDockerSessionIdentity(input).verified, false)
})
