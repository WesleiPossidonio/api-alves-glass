import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  validateBaselineConfig,
  validateProfile,
  validateTargetIdentity,
  validateMigrationsPath,
} from '../../../src/infra/persistence/config-validator.js'

const CANONICAL_BASELINE_MIGRATIONS_PATH = '/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone/src/infra/persistence/baseline/migrations'

describe('config-validator', () => {
  describe('validateBaselineConfig', () => {
    it('deve validar configuração completa corretamente', () => {
      const config = {
        BASELINE_DB_HOST: 'localhost',
        BASELINE_DB_PORT: '5432',
        BASELINE_DB_USERNAME: 'user',
        BASELINE_DB_PASSWORD: 'pass',
        BASELINE_DB_DATABASE: 'test_db',
        migrationStorage: 'sequelize',
        migrationStorageTableName: 'SequelizeMetaBaseline',
        migrationStorageTableSchema: 'baseline_meta',
      }
      const result = validateBaselineConfig(config)
      assert.strictEqual(result.valid, true)
      assert.strictEqual(result.errors.length, 0)
    })

    it('deve rejeitar configuração com campos obrigatórios ausentes', () => {
      const config = {
        BASELINE_DB_HOST: 'localhost',
        BASELINE_DB_PORT: '5432',
        BASELINE_DB_PASSWORD: 'pass',
        BASELINE_DB_DATABASE: 'test_db',
        migrationStorage: 'sequelize',
        migrationStorageTableName: 'SequelizeMetaBaseline',
        migrationStorageTableSchema: 'baseline_meta',
      }
      const result = validateBaselineConfig(config)
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('BASELINE_DB_USERNAME')))
    })

    it('deve rejeitar porta inválida', () => {
      const config = {
        BASELINE_DB_HOST: 'localhost',
        BASELINE_DB_PORT: '99999',
        BASELINE_DB_USERNAME: 'user',
        BASELINE_DB_PASSWORD: 'pass',
        BASELINE_DB_DATABASE: 'test_db',
        migrationStorage: 'sequelize',
        migrationStorageTableName: 'SequelizeMetaBaseline',
        migrationStorageTableSchema: 'baseline_meta',
      }
      const result = validateBaselineConfig(config)
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('PORT')))
    })

    it('deve rejeitar migrationStorageTableSchema incorreto', () => {
      const config = {
        BASELINE_DB_HOST: 'localhost',
        BASELINE_DB_PORT: '5432',
        BASELINE_DB_USERNAME: 'user',
        BASELINE_DB_PASSWORD: 'pass',
        BASELINE_DB_DATABASE: 'test_db',
        migrationStorage: 'sequelize',
        migrationStorageTableName: 'SequelizeMetaBaseline',
        migrationStorageTableSchema: 'public',
      }
      const result = validateBaselineConfig(config)
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('baseline_meta')))
    })
  })

  describe('validateProfile', () => {
    it('deve validar perfis válidos', () => {
      const validProfiles = ['development-rebuild', 'test', 'inventory-readonly', 'data-preservation']
      for (const profile of validProfiles) {
        const result = validateProfile(profile)
        assert.strictEqual(result.valid, true, `Perfil ${profile} deve ser válido`)
      }
    })

    it('deve rejeitar perfil inválido', () => {
      const result = validateProfile('invalid-profile')
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('inválido')))
    })
  })

  describe('validateTargetIdentity', () => {
    it('deve validar identidade completa', () => {
      const identity = { environment: 'development', host: 'localhost', port: 5432, database: 'test_db', profile: 'test' }
      const result = validateTargetIdentity(identity)
      assert.strictEqual(result.valid, true)
    })

    it('deve rejeitar identidade com campos ausentes', () => {
      const identity = { environment: 'development', host: 'localhost', database: 'test_db', profile: 'test' }
      const result = validateTargetIdentity(identity)
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('port')))
    })
  })

  describe('validateMigrationsPath', () => {
    it('deve validar caminho canônico correto', () => {
      const result = validateMigrationsPath(CANONICAL_BASELINE_MIGRATIONS_PATH, CANONICAL_BASELINE_MIGRATIONS_PATH)
      assert.strictEqual(result.valid, true)
    })

    it('deve rejeitar caminho diferente do canônico', () => {
      const result = validateMigrationsPath('/wrong/path', CANONICAL_BASELINE_MIGRATIONS_PATH)
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('canônico')))
    })

    it('deve rejeitar caminho legado', () => {
      const legacyPath = '/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone/src/database/migrations'
      const result = validateMigrationsPath(legacyPath, CANONICAL_BASELINE_MIGRATIONS_PATH)
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.some(e => e.includes('canônico')))
    })
  })
})