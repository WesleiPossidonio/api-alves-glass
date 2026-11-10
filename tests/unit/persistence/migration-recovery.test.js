import assert from 'node:assert/strict'
import test from 'node:test'
import { diagnoseMigrationRecovery } from '../../../src/infrastructure/persistence/migration-recovery.js'

const metadataValidated = Object.freeze({
  stage: 'metadata-validator',
  state: 'validated',
  blocked: false,
  details: Object.freeze({ metadataRelation: 'baseline_meta.SequelizeMetaBaseline' }),
})

const metadataBlocked = Object.freeze({
  stage: 'metadata-validator',
  state: 'blocked',
  blocked: true,
  details: Object.freeze({ metadataRelation: 'baseline_meta.SequelizeMetaBaseline' }),
})

const migrationName = '20261110000000-initial-baseline.cjs'

function createEvidence(overrides = {}) {
  return {
    resolution: { relation: 'baseline_meta.SequelizeMetaBaseline', qualified: true, searchPathUsed: false },
    metadata: { condition: 'valid' },
    canonicalMigrations: [migrationName],
    observedMigrations: [{ name: migrationName, metadataRecorded: true, schemaState: 'consistent' }],
    legacyHistory: { observed: false },
    ...overrides,
  }
}

test('T029 reconhece migration aplicada e registrada corretamente como already-current ou migration-already-recorded', () => {
  const current = diagnoseMigrationRecovery({
    metadataValidation: metadataValidated,
    recoveryEvidence: createEvidence(),
  })
  assert.equal(current.blocked, false)
  assert.equal(current.state, 'already-current')

  const recorded = diagnoseMigrationRecovery({
    metadataValidation: metadataValidated,
    recoveryEvidence: createEvidence(),
    requestedMigrationName: migrationName,
  })
  assert.equal(recorded.blocked, false)
  assert.equal(recorded.state, 'migration-already-recorded')
  assert.equal(recorded.details.automaticRecovery, false)
})

test('T029 exige recovery para migration registrada sem schema consistente ou parcialmente aplicada', () => {
  const cases = [
    createEvidence({ observedMigrations: [{ name: migrationName, metadataRecorded: true, schemaState: 'absent' }] }),
    createEvidence({ observedMigrations: [{ name: migrationName, metadataRecorded: false, schemaState: 'partial' }] }),
  ]

  for (const recoveryEvidence of cases) {
    const result = diagnoseMigrationRecovery({ metadataValidation: metadataValidated, recoveryEvidence })
    assert.equal(result.blocked, true)
    assert.equal(result.state, 'recovery-required')
    assert.equal(result.details.automaticRecovery, false)
  }
})

test('T029 exige recovery para objetos consistentes sem registro e nome de metadata incompatível', () => {
  const withoutRecord = diagnoseMigrationRecovery({
    metadataValidation: metadataValidated,
    recoveryEvidence: createEvidence({
      observedMigrations: [{ name: migrationName, metadataRecorded: false, schemaState: 'consistent' }],
    }),
  })
  assert.equal(withoutRecord.state, 'recovery-required')

  const incompatibleName = diagnoseMigrationRecovery({
    metadataValidation: metadataValidated,
    recoveryEvidence: createEvidence({
      observedMigrations: [
        { name: migrationName, metadataRecorded: true, schemaState: 'consistent' },
        { name: 'legacy-unmapped.js', metadataRecorded: true, schemaState: 'consistent' },
      ],
    }),
  })
  assert.equal(incompatibleName.state, 'recovery-required')
})

test('T029 exige recovery para metadata ausente ou divergente após tentativa controlada', () => {
  for (const condition of ['absent', 'unexpected-schema', 'divergent']) {
    const result = diagnoseMigrationRecovery({
      metadataValidation: metadataBlocked,
      recoveryEvidence: createEvidence({ metadata: { condition } }),
    })
    assert.equal(result.blocked, true)
    assert.equal(result.state, 'recovery-required')
    assert.match(result.errors.join('\n'), /Metadata canônica/)
  }
})

test('T029 não aceita histórico legado como baseline sem inventário e estratégia explícita', () => {
  const result = diagnoseMigrationRecovery({
    metadataValidation: metadataValidated,
    recoveryEvidence: createEvidence({
      legacyHistory: { observed: true, inventoryProvided: false, strategyApproved: false },
    }),
  })

  assert.equal(result.blocked, true)
  assert.equal(result.state, 'recovery-required')
  assert.match(result.errors.join('\n'), /Histórico legado exige inventário e estratégia explícita/)
})

test('T029 bloqueia evidência ausente, incompleta, ambígua ou contraditória', () => {
  const cases = [
    { metadataValidation: metadataValidated },
    {
      metadataValidation: metadataValidated,
      recoveryEvidence: createEvidence({ observedMigrations: [] }),
    },
    {
      metadataValidation: metadataValidated,
      recoveryEvidence: createEvidence({
        observedMigrations: [
          { name: migrationName, metadataRecorded: true, schemaState: 'consistent' },
          { name: migrationName, metadataRecorded: true, schemaState: 'consistent' },
        ],
      }),
    },
    {
      metadataValidation: metadataValidated,
      recoveryEvidence: createEvidence({ metadata: { condition: 'absent' } }),
    },
  ]

  for (const input of cases) {
    const result = diagnoseMigrationRecovery(input)
    assert.equal(result.blocked, true)
    assert.equal(result.state, 'blocked')
  }
})

test('T029 não executa recuperação automática, rejeita campos externos e sanitiza diagnósticos não confiáveis', () => {
  const result = diagnoseMigrationRecovery({
    metadataValidation: metadataValidated,
    recoveryEvidence: createEvidence({
      observedMigrations: [{
        name: 'postgresql://reader:super-secret@postgres-test:5432/alvesglass_test',
        metadataRecorded: false,
        schemaState: 'partial',
      }],
    }),
  })
  assert.equal(result.blocked, true)
  assert.equal(result.errors.join('\n').includes('super-secret'), false)
  assert.match(result.errors.join('\n'), /incompleta|\[DATABASE_URL_REDACTED\]/)

  const unknownField = diagnoseMigrationRecovery({
    metadataValidation: metadataValidated,
    recoveryEvidence: createEvidence(),
    processExecutor: {},
  })
  assert.equal(unknownField.blocked, true)
  assert.match(unknownField.errors.join('\n'), /não permitido/)
})

test('T029 importa sem efeitos colaterais, sem conexão ou escrita', async () => {
  const module = await import('../../../src/infrastructure/persistence/migration-recovery.js')
  assert.equal(typeof module.diagnoseMigrationRecovery, 'function')
})