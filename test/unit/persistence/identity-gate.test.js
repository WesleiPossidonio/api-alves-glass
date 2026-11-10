import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  validateIdentityLists,
  identitiesMatch,
  checkIdentityAuthorization,
} from '../../../src/infra/persistence/config-validator.js'

describe('identity-gate (T006) - validateIdentityLists e identitiesMatch', () => {
  describe('validateIdentityLists', () => {
    it('deve validar allowlist e denylist corretas', () => {
      const allowlist = [
        { environment: 'development', host: 'localhost', port: 55432, database: 'baseline_dev', profile: 'development-rebuild' },
      ]
      const denylist = [
        { environment: 'production', host: 'prod-host', port: 5432, database: 'prod_db', profile: 'production' },
      ]
      const result = validateIdentityLists(allowlist, denylist)
      assert.strictEqual(result.valid, true)
    })

    it('deve rejeitar allowlist vazia', () => {
      const result = validateIdentityLists([], [])
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('allowlist')))
    })

    it('deve rejeitar denylist ausente', () => {
      const allowlist = [{ environment: 'development', host: 'localhost', port: 55432, database: 'baseline_dev', profile: 'development-rebuild' }]
      const result = validateIdentityLists(allowlist, null)
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('denylist')))
    })

    it('deve rejeitar sobreposição entre allowlist e denylist', () => {
      const identity = { environment: 'development', host: 'localhost', port: 55432, database: 'baseline_dev', profile: 'development-rebuild' }
      const result = validateIdentityLists([identity], [identity])
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('allowlist quanto na denylist')))
    })
  })

  describe('identitiesMatch', () => {
    it('deve retornar true para identidades idênticas', () => {
      const a = { environment: 'development', host: 'localhost', port: 5432, database: 'test', profile: 'test' }
      const b = { environment: 'development', host: 'localhost', port: 5432, database: 'test', profile: 'test' }
      assert.strictEqual(identitiesMatch(a, b), true)
    })

    it('deve retornar false para identidades diferentes em host', () => {
      const a = { environment: 'development', host: 'localhost', port: 5432, database: 'test', profile: 'test' }
      const b = { environment: 'development', host: 'other', port: 5432, database: 'test', profile: 'test' }
      assert.strictEqual(identitiesMatch(a, b), false)
    })

    it('deve retornar false para identidades diferentes em porta', () => {
      const a = { environment: 'development', host: 'localhost', port: 5432, database: 'test', profile: 'test' }
      const b = { environment: 'development', host: 'localhost', port: 5433, database: 'test', profile: 'test' }
      assert.strictEqual(identitiesMatch(a, b), false)
    })

    it('deve retornar false para identidades diferentes em database', () => {
      const a = { environment: 'development', host: 'localhost', port: 5432, database: 'test', profile: 'test' }
      const b = { environment: 'development', host: 'localhost', port: 5432, database: 'other', profile: 'test' }
      assert.strictEqual(identitiesMatch(a, b), false)
    })

    it('deve retornar false para identidades diferentes em profile', () => {
      const a = { environment: 'development', host: 'localhost', port: 5432, database: 'test', profile: 'test' }
      const b = { environment: 'development', host: 'localhost', port: 5432, database: 'test', profile: 'development-rebuild' }
      assert.strictEqual(identitiesMatch(a, b), false)
    })

    it('deve retornar false para identidades diferentes em environment', () => {
      const a = { environment: 'development', host: 'localhost', port: 5432, database: 'test', profile: 'test' }
      const b = { environment: 'production', host: 'localhost', port: 5432, database: 'test', profile: 'test' }
      assert.strictEqual(identitiesMatch(a, b), false)
    })
  })
})