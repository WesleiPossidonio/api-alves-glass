import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { runInstancePreflight, runDatabaseIdentityPreflight } from '../../../src/infra/persistence/preflight.js'

describe('preflight (T005/T006)', () => {
  const originalEnv = { ...process.env }

  before(() => {
    // Configura ambiente de teste com allowlist/denylist válidas
    process.env.NODE_ENV = 'development'
    process.env.BASELINE_DB_HOST = 'localhost'
    process.env.BASELINE_DB_PORT = '55432'
    process.env.BASELINE_DB_USERNAME = 'test_user'
    process.env.BASELINE_DB_PASSWORD = 'test_pass'
    process.env.BASELINE_DB_DATABASE = 'baseline_test'
    process.env.BASELINE_MIGRATIONS_PATH = '/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone/src/infra/persistence/baseline/migrations'
    process.env.BASELINE_ALLOWLIST = JSON.stringify([
      { environment: 'development', host: 'localhost', port: 55432, database: 'baseline_test', profile: 'test' },
      { environment: 'development', host: 'localhost', port: 55432, database: 'baseline_dev', profile: 'development-rebuild' },
    ])
    process.env.BASELINE_DENYLIST = JSON.stringify([
      { environment: 'production', host: 'prod-host', port: 5432, database: 'prod_db', profile: 'production' },
    ])
  })

  after(() => {
    // Restaura ambiente original
    process.env = { ...originalEnv }
  })

  describe('runInstancePreflight', () => {
    it('deve validar perfil test com identidade autorizada', async () => {
      const result = await runInstancePreflight('test')
      assert.strictEqual(result.validated, true)
      assert.strictEqual(result.blocked, false)
      assert.strictEqual(result.profile, 'test')
      assert.ok(result.identity)
      assert.strictEqual(result.identity.host, 'localhost')
      assert.strictEqual(result.identity.port, 55432)
      assert.strictEqual(result.identity.database, 'baseline_test')
    })

    it('deve validar perfil development-rebuild com ambiente development', async () => {
      const result = await runInstancePreflight('development-rebuild')
      assert.strictEqual(result.validated, true)
      assert.strictEqual(result.blocked, false)
      assert.strictEqual(result.profile, 'development-rebuild')
    })

    it('deve bloquear perfil inválido', async () => {
      const result = await runInstancePreflight('invalid-profile')
      assert.strictEqual(result.blocked, true)
      assert.ok(result.errors.some(e => e.includes('inválido')))
    })

    it('deve bloquear quando allowlist não está configurada', async () => {
      delete process.env.BASELINE_ALLOWLIST
      delete process.env.BASELINE_DENYLIST
      const result = await runInstancePreflight('test')
      assert.strictEqual(result.blocked, true)
      assert.ok(result.errors.some(e => e.includes('allowlist')))
    })
  })

  describe('runDatabaseIdentityPreflight', () => {
    it('deve validar identidade do banco quando preflight da instância é válido', async () => {
      const instanceResult = await runInstancePreflight('test')
      const result = await runDatabaseIdentityPreflight({ instance: instanceResult, database: { validated: true, profile: 'test' } })
      assert.strictEqual(result.validated, true)
      assert.strictEqual(result.blocked, false)
    })

    it('deve bloquear quando preflight da instância não foi validado', async () => {
      const instanceResult = { validated: false, profile: 'test', identity: null }
      const result = await runDatabaseIdentityPreflight({ instance: instanceResult, database: { validated: true, profile: 'test' } })
      assert.strictEqual(result.blocked, true)
      assert.ok(result.errors.some(e => e.includes('não foi validado')))
    })
  })
})