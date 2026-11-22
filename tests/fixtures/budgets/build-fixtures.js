// Synthetic fixtures ONLY. No production PDF parser, validator or encryption API.
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex')
const documentId = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
const md5 = value => createHash('md5').update(value).digest()
const padded = value => Buffer.concat([Buffer.from(value, 'ascii'), padding]).subarray(0, 32)

// PDF Standard Security Handler R2 fixture construction, intentionally obsolete
// 40-bit RC4. It protects no real data; never export or use this in application code.
function rc4(key, input) {
  const s = Array.from({ length: 256 }, (_, i) => i)
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) % 256
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  let i = 0
  j = 0
  return Buffer.from(input.map(byte => {
    i = (i + 1) % 256
    j = (j + s[i]) % 256
    ;[s[i], s[j]] = [s[j], s[i]]
    return byte ^ s[(s[i] + s[j]) % 256]
  }))
}

function encryptionDictionary(password) {
  const owner = rc4(md5(padded('fixture-owner-only')).subarray(0, 5), padded(password))
  const permissions = Buffer.alloc(4)
  permissions.writeInt32LE(-4)
  const key = md5(Buffer.concat([padded(password), owner, permissions, documentId])).subarray(0, 5)
  const user = rc4(key, padding)
  return `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`
}

export function buildPdf({ password, size } = {}) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>',
  ]
  if (password !== undefined) objects.push(encryptionDictionary(password))
  let body = '%PDF-1.4\n% Synthetic Feature 005 blank page\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${password !== undefined
    ? ` /Encrypt 4 0 R /ID [<${documentId.toString('hex')}> <${documentId.toString('hex')}>]` : ''} >>\n`
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}${trailer}`
  const finish = extra => `${body}${extra}${xref}startxref\n${Buffer.byteLength(body) + Buffer.byteLength(extra)}\n%%EOF\n`
  if (size === undefined) return Buffer.from(finish(''), 'ascii')
  // Pad with harmless comments BEFORE xref; all object offsets remain unchanged.
  let count = size - Buffer.byteLength(finish(''))
  for (let attempt = 0; attempt < 10; attempt++) {
    if (count < 2) throw new Error('FIXTURE_SIZE_TOO_SMALL')
    const output = Buffer.from(finish(`%${' '.repeat(count - 2)}\n`), 'ascii')
    if (output.length === size) return output
    count += size - output.length
  }
  throw new Error('FIXTURE_SIZE_NOT_REACHED')
}

export function fixtureBuffers() {
  const plain = buildPdf()
  return {
    'plain.pdf': plain,
    'password-required.pdf': buildPdf({ password: 'fixture-user-only' }),
    'empty-password.pdf': buildPdf({ password: '' }),
    // Damaged xref requires recovery; confirmed as check exit 3 by qpdf 12.3.2.
    'warning-xref.pdf': Buffer.from(plain.toString('ascii').replace(/startxref\n\d+/, 'startxref\n0')),
    'corrupt.pdf': Buffer.from('%PDF-1.4\nnot an indirect object or trailer\n'),
    'truncated.pdf': plain.subarray(0, 70),
    'renamed-non-pdf.pdf': Buffer.from('Synthetic non-PDF. No client data.\n'),
    'empty.pdf': Buffer.alloc(0),
  }
}

export function fixtureManifest(observations = null) {
  const expectations = {
    'plain.pdf': [2, 0, 'accept'],
    'password-required.pdf': [0, 2, 'passwordRequired'],
    'empty-password.pdf': [3, 0, 'accept'],
    'warning-xref.pdf': [2, 3, 'invalidPdf'],
    'corrupt.pdf': [2, 2, 'invalidPdf'],
    'truncated.pdf': [2, 2, 'invalidPdf'],
    'renamed-non-pdf.pdf': [2, 2, 'unsupportedMediaType'],
    'empty.pdf': [2, 2, 'invalidPdf'],
  }
  const manifest = {
    schemaVersion: 1,
    provenance: 'Locally generated synthetic blank PDFs; no third-party or client documents.',
    qpdfVerification: { status: 'blocked', reason: 'qpdf executable unavailable; expected exits are hypotheses until real smoke in T022', version: null },
    fixtures: Object.entries(fixtureBuffers()).map(([file, bytes]) => ({
      file, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      expectedRequiresPasswordExit: expectations[file][0], expectedCheckExit: expectations[file][1],
      expectedUploadResult: expectations[file][2], observedRequiresPasswordExit: null, observedCheckExit: null,
      note: 'Never accept observed exits by rewriting expectations automatically; review unexpected results.',
    })),
    boundaries: [10485759, 10485760, 10485761].map(sizeBytes => ({
      recipe: 'buildPdf({ size: sizeBytes })', sizeBytes,
      expectedSizeAllowed: sizeBytes <= 10485760,
      expectedRequiresPasswordExit: 2, expectedCheckExit: 0, observedCheckExit: null,
    })),
  }
  if (observations) {
    assert.match(observations.imageId, /^sha256:[a-f0-9]{64}$/)
    assert.equal(observations.fixtures.length, manifest.fixtures.length)
    assert.equal(observations.boundaries.length, manifest.boundaries.length)
    for (const fixture of manifest.fixtures) {
      const observed = observations.fixtures.find(item => item.file === fixture.file)
      assert.equal(observed.sha256, fixture.sha256)
      assert.equal(observed.sizeBytes, fixture.sizeBytes)
      assert.equal(observed.check.exit, fixture.expectedCheckExit)
      assert.equal(observed.requiresPassword.exit, fixture.expectedRequiresPasswordExit)
      fixture.observedCheckExit = observed.check.exit
      fixture.observedRequiresPasswordExit = observed.requiresPassword.exit
    }
    for (const boundary of manifest.boundaries) {
      const observed = observations.boundaries.find(item => item.sizeBytes === boundary.sizeBytes)
      assert.equal(observed.check.exit, boundary.expectedCheckExit)
      assert.equal(observed.requiresPassword.exit, boundary.expectedRequiresPasswordExit)
      boundary.observedCheckExit = observed.check.exit
      boundary.observedRequiresPasswordExit = observed.requiresPassword.exit
    }
    manifest.qpdfVerification = {
      status: 'verified', version: observations.version.split('\n')[0],
      imageId: observations.imageId, effectiveUid: observations.uid,
      evidence: 'qpdf-observed.json',
    }
  }
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = dirname(fileURLToPath(import.meta.url))
  for (const [file, bytes] of Object.entries(fixtureBuffers())) writeFileSync(join(directory, file), bytes)
  const observations = JSON.parse(readFileSync(join(directory, 'qpdf-observed.json')))
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(fixtureManifest(observations), null, 2)}\n`)
}