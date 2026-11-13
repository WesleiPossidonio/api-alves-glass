import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { imageUpload } from '../../src/config/multer.js'

test('image-specific Multer instance is bounded to 5 MiB without changing legacy budget upload', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const source = fs.readFileSync(path.join(root, 'src/config/multer.js'), 'utf8')
  assert.equal(imageUpload.limits.fileSize, 5 * 1024 * 1024)
  assert.match(source, /fileSize: 10 \* 1024 \* 1024/)
})