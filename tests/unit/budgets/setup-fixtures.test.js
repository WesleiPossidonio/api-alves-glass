import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { buildPdf, fixtureBuffers, fixtureManifest } from '../../fixtures/budgets/build-fixtures.js'

const directory = new URL('../../fixtures/budgets/', import.meta.url)

test('T003 fixture corpus is deterministic, byte-for-byte reproducible and hash pinned', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory)))
  const observations = JSON.parse(readFileSync(new URL('qpdf-observed.json', directory)))
  assert.deepEqual(manifest, fixtureManifest(observations))
  const fixtures = fixtureBuffers()
  for (const fixture of manifest.fixtures) {
    const bytes = readFileSync(new URL(fixture.file, directory))
    assert.deepEqual(bytes, fixtures[fixture.file])
    assert.equal(bytes.length, fixture.sizeBytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256)
    assert.equal(fixture.observedCheckExit, fixture.expectedCheckExit)
    assert.equal(fixture.observedRequiresPasswordExit, fixture.expectedRequiresPasswordExit)
    assert.equal(fixture.expectedUploadResult === 'accept',
      fixture.observedCheckExit === 0 && [2, 3].includes(fixture.observedRequiresPasswordExit))
  }
  assert.equal(manifest.qpdfVerification.status, 'verified')
})

test('T003 recorded observations cannot silently rewrite expected codes or hashes', () => {
  const observations = JSON.parse(readFileSync(new URL('qpdf-observed.json', directory)))
  for (const mutate of [
    report => { report.fixtures[0].check.exit = 3 },
    report => { report.fixtures[0].requiresPassword.exit = 0 },
    report => { report.fixtures[0].sha256 = 'incorrect' },
    report => { report.boundaries[0].check.exit = 2 },
  ]) {
    const changed = structuredClone(observations)
    mutate(changed)
    assert.throws(() => fixtureManifest(changed))
  }
})

test('T003 valid synthetic fixtures have exact xref and object offsets (not a qpdf validation)', () => {
  for (const name of ['plain.pdf', 'password-required.pdf', 'empty-password.pdf']) {
    const text = fixtureBuffers()[name].toString('ascii')
    const xref = Number(text.match(/startxref\n(\d+)/)[1])
    assert.equal(text.slice(xref, xref + 4), 'xref')
    const offsets = [...text.slice(xref).matchAll(/(\d{10}) 00000 n /g)]
    for (const [i, match] of offsets.entries()) assert.equal(text.slice(Number(match[1])).startsWith(`${i + 1} 0 obj\n`), true)
    assert.equal(/\/(JavaScript|JS|OpenAction|AA|EmbeddedFile)\b/.test(text), false)
  }
})

test('T003 boundaries are generated in memory with exact sizes without persisting large files', () => {
  for (const size of [10485759, 10485760, 10485761]) {
    const bytes = buildPdf({ size })
    assert.equal(bytes.length, size)
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
    const xref = Number(bytes.subarray(-50).toString().match(/startxref\n(\d+)/)[1])
    assert.equal(bytes.subarray(xref, xref + 4).toString(), 'xref')
  }
})