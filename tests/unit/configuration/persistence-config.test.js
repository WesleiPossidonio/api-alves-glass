import assert from 'node:assert/strict'
import test from 'node:test'
import { loadPersistenceConfig, readPersistenceConfig, redactPersistenceConfig, validatePersistenceConfig } from '../../../src/infrastructure/config/persistence-config.js'

const validEnvironment = Object.freeze({
  PERSISTENCE_PROFILE: 'development-rebuild',
  NODE_ENV: 'development',
  PERSISTENCE_INSTANCE_HOST: 'synthetic-host',
  PERSISTENCE_INSTANCE_PORT: '55432',
  PERSISTENCE_INSTANCE_PROFILE: 'development-rebuild',
  BASELINE_DB_HOST: 'synthetic-host',
  BASELINE_DB_PORT: '55432',
  BASELINE_DB_DATABASE: 'synthetic-baseline',
  BASELINE_DB_USERNAME: 'synthetic-user',
  BASELINE_DB_PASSWORD: 'synthetic-password',
  PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE: 'synthetic-original-reference',
  BASELINE_MIGRATIONS_PATH: '/synthetic/project/src/database/baseline',
  BASELINE_IDENTITY_CONFIG_PATH: '/synthetic/identities.json',
})

test('T017 aceita configuração sintética válida e lê somente os campos reconhecidos', () => {
  const result = loadPersistenceConfig({ ...validEnvironment, UNRELATED_SECRET: 'must-not-be-read' }, {
    requiresConnectionCredentials: true,
  })

  assert.equal(result.valid, true)
  assert.deepEqual(readPersistenceConfig({ ...validEnvironment, UNRELATED_SECRET: 'must-not-be-read' }).UNRELATED_SECRET, undefined)
  assert.equal(result.config.BASELINE_DB_PORT, 55432)
})

test('T017 bloqueia campos obrigatórios ausentes, perfil desconhecido e portas inválidas', () => {
  const missingField = validatePersistenceConfig({ ...validEnvironment, BASELINE_DB_DATABASE: '' })
  assert.equal(missingField.valid, false)
  assert.match(missingField.errors.join('\n'), /BASELINE_DB_DATABASE/)

  const unknownProfile = validatePersistenceConfig({ ...validEnvironment, PERSISTENCE_PROFILE: 'unknown-profile' })
  assert.equal(unknownProfile.valid, false)
  assert.match(unknownProfile.errors.join('\n'), /não reconhecido/)

  const invalidPort = validatePersistenceConfig({ ...validEnvironment, BASELINE_DB_PORT: '70000' })
  assert.equal(invalidPort.valid, false)
  assert.match(invalidPort.errors.join('\n'), /BASELINE_DB_PORT.*porta inteira/)
})

test('T017 bloqueia incompatibilidade de ambiente/perfis e ausência de credenciais exigidas', () => {
  const incompatibleEnvironment = validatePersistenceConfig({ ...validEnvironment, NODE_ENV: 'test' })
  assert.equal(incompatibleEnvironment.valid, false)
  assert.match(incompatibleEnvironment.errors.join('\n'), /NODE_ENV.*development/)

  const divergentProfiles = validatePersistenceConfig({ ...validEnvironment, PERSISTENCE_INSTANCE_PROFILE: 'test' })
  assert.equal(divergentProfiles.valid, false)
  assert.match(divergentProfiles.errors.join('\n'), /PERSISTENCE_INSTANCE_PROFILE/)

  const missingCredentials = validatePersistenceConfig({
    ...validEnvironment,
    BASELINE_DB_USERNAME: '',
    BASELINE_DB_PASSWORD: '',
  }, { requiresConnectionCredentials: true })
  assert.equal(missingCredentials.valid, false)
  assert.match(missingCredentials.errors.join('\n'), /BASELINE_DB_USERNAME/)
  assert.match(missingCredentials.errors.join('\n'), /BASELINE_DB_PASSWORD/)
})

test('T017 redige segredos e importação não causa efeito operacional', async () => {
  const redacted = redactPersistenceConfig(validEnvironment)
  assert.equal(redacted.BASELINE_DB_USERNAME, '[REDACTED]')
  assert.equal(redacted.BASELINE_DB_PASSWORD, '[REDACTED]')
  assert.equal(JSON.stringify(redacted).includes('synthetic-password'), false)

  await import('../../../src/infrastructure/config/persistence-config.js')
})