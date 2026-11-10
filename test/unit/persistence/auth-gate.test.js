import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  checkIdentityAuthorization,
  loadAndValidateBaselineConfig,
} from '../../../src/infra/persistence/config-validator.js'

const CANONICAL_BASELINE_MIGRATIONS_PATH = '/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone/src/infra/persistence/baseline/migrations'

describe('auth-gate (T006) - checkIdentityAuthorization e loadAndValidateBaselineConfig', () => {
  const allowedIdentity = { environment: 'development', host: 'localhost', port: 55432, database: 'baseline_dev', profile: 'development-rebuild' }
  const deniedIdentity = { environment: 'production', host: 'prod', port: 5432, database: 'prod', profile: 'production' }
  const allowlist = [allowedIdentity]
  const denylist = [deniedIdentity]

  describe('checkIdentityAuthorization (fail-closed)', () => {
    it('deve autorizar identidade que corresponde exatamente a uma entrada na allowlist e nenhuma na denylist', () => {
      const result = checkIdentityAuthorization(allowedIdentity, allowlist, denylist)
      assert.strictEqual(result.authorized, true)
      assert.strictEqual(result.matchedAllowlist, allowedIdentity)
    })

    it('deve bloquear identidade que coincide com denylist (fail-closed)', () => {
      const result = checkIdentityAuthorization(deniedIdentity, allowlist, denylist)
      assert.strictEqual(result.authorized, false)
      assert.ok(result.errors.some(e => e.includes('protegida')))
    })

    it('deve bloquear identidade que não está na allowlist', () => {
      const unknownIdentity = { environment: 'development', host: 'unknown', port: 55432, database: 'unknown', profile: 'development-rebuild' }
      const result = checkIdentityAuthorization(unknownIdentity, allowlist, denylist)
      assert.strictEqual(result.authorized, false)
      assert.ok(result.errors.some(e => e.includes('não corresponde')))
    })

    it('deve bloquear identidade ambígua (múltiplas correspondências na allowlist)', () => {
      const duplicateAllowlist = [allowedIdentity, allowedIdentity]
      const result = checkIdentityAuthorization(allowedIdentity, duplicateAllowlist, denylist)
      assert.strictEqual(result.authorized, false)
      assert.ok(result.errors.some(e => e.includes('ambiguidade')))
    })

    it('deve bloquear identidade ausente', () => {
      const result = checkIdentityAuthorization(null, allowlist, denylist)
      assert.strictEqual(result.authorized, false)
      assert.ok(result.errors.some(e => e.includes('obrigatória')))
    })

    it('deve bloquear quando allowlist está vazia', () => {
      const result = checkIdentityAuthorization(allowedIdentity, [], denylist)
      assert.strictEqual(result.authorized, false)
      assert.ok(result.errors.some(e => e.includes('não corresponde')))
    })
  })

  describe('loadAndValidateBaselineConfig', () => {
    it('deve carregar e validar configuração completa', () => {
      const env = {
        BASELINE_DB_HOST: 'localhost',
        BASELINE_DB_PORT: '5432',
        BASELINE_DB_USERNAME: 'user',
        BASELINE_DB_PASSWORD: 'pass',
        BASELINE_DB_DATABASE: 'test_db',
        BASELINE_MIGRATIONS_PATH: CANONICAL_BASELINE_MIGRATIONS_PATH,
      }
      const result = loadAndValidateBaselineConfig(env, CANONICAL_BASELINE_MIGRATIONS_PATH)
      assert.strictEqual(result.valid, true)
      assert.strictEqual(result.config.BASELINE_DB_HOST, 'localhost')
      assert.strictEqual(result.config.migrationStorageTableSchema, 'baseline_meta')
    })

    it('deve falhar com configuração incompleta', () => {
      const env = {
        BASELINE_DB_HOST: 'localhost',
        BASELINE_DB_PORT: '5432',
        BASELINE_MIGRATIONS_PATH: CANONICAL_BASELINE_MIGRATIONS_PATH,
      }
      const result = loadAndValidateBaselineConfig(env, CANONICAL_BASELINE_MIGRATIONS_PATH)
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.length > 0)
    })

    it('deve falhar com caminho de migrations incorreto', () => {
      const env = {
        BASELINE_DB_HOST: 'localhost',
        BASELINE_DB_PORT: '5432',
        BASELINE_DB_USERNAME: 'user',
        BASELINE_DB_PASSWORD: 'pass',
        BASELINE_DB_DATABASE: 'test_db',
        BASELINE_MIGRATIONS_PATH: '/wrong/path',
      }
      const result = loadAndValidateBaselineConfig(env, CANONICAL_BASELINE_MIGRATIONS_PATH)
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('canônico')))
    })
  })
})