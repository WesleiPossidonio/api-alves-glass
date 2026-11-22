// Explicit, offline T003 fixture verifier. Not an application PDF validator.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPdf, fixtureManifest } from '../../fixtures/budgets/build-fixtures.js'

function execute(args) {
  const result = spawnSync('qpdf', args, {
    shell: false, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, LANG: 'C', HOME: tmpdir() },
  })
  if (result.error || result.signal || !Number.isInteger(result.status)) {
    throw new Error('QPDF_EXECUTION_FAILED', { cause: result.error })
  }
  return { exit: result.status, stdout: result.stdout, stderr: result.stderr }
}

const imageId = process.argv[2]
assert.match(imageId ?? '', /^sha256:[a-f0-9]{64}$/)
const version = execute(['--version'])
assert.equal(version.exit, 0)
const expected = fixtureManifest()
const directory = fileURLToPath(new URL('../../fixtures/budgets/', import.meta.url))
const report = {
  schemaVersion: 1, imageId, version: version.stdout.trim(),
  uid: process.getuid(), fixtures: [], boundaries: [],
}

function observe(path, recipe) {
  const bytes = readFileSync(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (recipe.sha256) assert.equal(sha256, recipe.sha256)
  assert.equal(bytes.length, recipe.sizeBytes)
  // Deliberately separate commands: password status alone proves no structure.
  const check = execute(['--check', path])
  const requiresPassword = execute(['--requires-password', path])
  const observation = { sizeBytes: bytes.length, sha256, check, requiresPassword }
  assert.equal(check.exit, recipe.expectedCheckExit, `${path}: check mismatch`)
  assert.equal(requiresPassword.exit, recipe.expectedRequiresPasswordExit, `${path}: password mismatch`)
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), sha256)
  return observation
}

for (const fixture of expected.fixtures) {
  report.fixtures.push({ file: fixture.file, ...observe(join(directory, fixture.file), fixture) })
}

// Sequential execution bounds concurrency at one. Private temporary directory,
// always removed. The +1 case proves parser behavior, not upload-size acceptance.
const temporary = mkdtempSync(join(tmpdir(), 'feature005-qpdf-'))
try {
  for (const boundary of expected.boundaries) {
    const path = join(temporary, 'boundary.pdf')
    writeFileSync(path, buildPdf({ size: boundary.sizeBytes }), { mode: 0o600 })
    report.boundaries.push(observe(path, boundary))
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
console.log(JSON.stringify(report, null, 2))