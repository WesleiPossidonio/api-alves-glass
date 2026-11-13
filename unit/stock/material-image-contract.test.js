import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import routes from '../../src/routes.js'

test('material image workflow is not exposed as HTTP until persistence schema is approved/applied', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const source = fs.readFileSync(path.join(root, 'src/app/services/MaterialImageService.js'), 'utf8')
  assert.match(source, /storagePersistenceUnavailable/)
  assert.doesNotMatch(routes.stack.map(layer => layer.route?.path).filter(Boolean).join('\n'), /image/)
})