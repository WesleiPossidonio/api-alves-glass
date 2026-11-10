import assert from 'node:assert/strict'
import test from 'node:test'
import { validateBaselineMetadata } from '../../../src/infrastructure/persistence/metadata-validator.js'

const cliExecution = Object.freeze({
  stage: 'baseline-cli-runner',
  state: 'validated',
  blocked: false,
  details: Object.freeze({ metadataRelation: 'baseline_meta.SequelizeMetaBaseline' }),
})

function createValidEvidence(overrides = {}) {
  return {
    resolvedRelation: 'baseline_meta.SequelizeMetaBaseline',
    resolution: { qualified: true, searchPathUsed: false },
    schema: { name: 'baseline_meta', exists: true },
    table: { schema: 'baseline_meta', name: 'SequelizeMetaBaseline', exists: true },
    nameColumn: { exists: true, nullable: false },
    constraints: [{ type: 'PRIMARY KEY', columns: ['name'] }],
    ...overrides,
  }
}

function createObserver(evidence) {
  const calls = []
  return {
    calls,
    observer: {
      async observeMetadata(relation) {
        calls.push(relation)
        return evidence
      },
      async writeMetadata() {
        throw new Error('operações de escrita não são permitidas')
      },
    },
  }
}

test('T028 valida exclusivamente baseline_meta.SequelizeMetaBaseline por evidência qualificada de leitura', async () => {
  const { observer, calls } = createObserver(createValidEvidence({
    constraints: [{ type: 'UNIQUE', columns: ['name'] }],
  }))

  const result = await validateBaselineMetadata({ cliExecution, metadataObserver: observer })

  assert.equal(result.blocked, false)
  assert.equal(result.stage, 'metadata-validator')
  assert.equal(result.state, 'validated')
  assert.deepEqual(calls, ['baseline_meta.SequelizeMetaBaseline'])
  assert.equal(result.details.nameConstraint, 'UNIQUE')
})

test('T028 bloqueia schema ou metadata ausentes, coluna nullable e ausência de PK ou UNIQUE exclusiva', async () => {
  const cases = [
    createValidEvidence({ schema: { name: 'baseline_meta', exists: false } }),
    createValidEvidence({ table: { schema: 'baseline_meta', name: 'SequelizeMetaBaseline', exists: false } }),
    createValidEvidence({ nameColumn: { exists: true, nullable: true } }),
    createValidEvidence({ constraints: [{ type: 'UNIQUE', columns: ['other_column'] }] }),
  ]

  for (const evidence of cases) {
    const { observer } = createObserver(evidence)
    const result = await validateBaselineMetadata({ cliExecution, metadataObserver: observer })
    assert.equal(result.blocked, true)
  }
})

test('T028 bloqueia schema, tabela ou relação divergentes e public.SequelizeMeta não substitui o baseline', async () => {
  const cases = [
    createValidEvidence({ schema: { name: 'public', exists: true } }),
    createValidEvidence({ table: { schema: 'public', name: 'SequelizeMetaBaseline', exists: true } }),
    createValidEvidence({ resolvedRelation: 'public.SequelizeMeta' }),
  ]

  for (const evidence of cases) {
    const { observer } = createObserver(evidence)
    const result = await validateBaselineMetadata({ cliExecution, metadataObserver: observer })
    assert.equal(result.blocked, true)
    assert.match(result.errors.join('\n'), /baseline_meta|canônico|relação observada/)
  }
})

test('T028 bloqueia fallback por search_path e evidência incompleta', async () => {
  const fallback = await validateBaselineMetadata({
    cliExecution,
    metadataObserver: createObserver(createValidEvidence({ resolution: { qualified: false, searchPathUsed: true } })).observer,
  })
  assert.equal(fallback.blocked, true)
  assert.match(fallback.errors.join('\n'), /search_path/)

  const incomplete = await validateBaselineMetadata({
    cliExecution,
    metadataObserver: createObserver({ resolvedRelation: 'baseline_meta.SequelizeMetaBaseline' }).observer,
  })
  assert.equal(incomplete.blocked, true)
})

test('T028 bloqueia ausência de pós-CLI válido, adaptador ausente e campos não autorizados sem observar catálogo', async () => {
  const { observer, calls } = createObserver(createValidEvidence())

  const withoutCli = await validateBaselineMetadata({ metadataObserver: observer })
  assert.equal(withoutCli.blocked, true)

  const withoutObserver = await validateBaselineMetadata({ cliExecution })
  assert.equal(withoutObserver.blocked, true)

  const unknownField = await validateBaselineMetadata({ cliExecution, metadataObserver: observer, searchPath: 'public' })
  assert.equal(unknownField.blocked, true)
  assert.deepEqual(calls, [])
})

test('T028 bloqueia falha do adaptador, redige credenciais e a importação não observa nem escreve', async () => {
  const result = await validateBaselineMetadata({
    cliExecution,
    metadataObserver: {
      async observeMetadata() {
        throw new Error('password=super-secret postgresql://reader:super-secret@postgres-test:5432/alvesglass_test')
      },
    },
  })

  assert.equal(result.blocked, true)
  assert.equal(result.errors.join('\n').includes('super-secret'), false)
  assert.match(result.errors.join('\n'), /\[REDACTED\]|\[DATABASE_URL_REDACTED\]/)

  const module = await import('../../../src/infrastructure/persistence/metadata-validator.js')
  assert.equal(typeof module.validateBaselineMetadata, 'function')
})