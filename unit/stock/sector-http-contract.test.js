import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import SectorController from '../../src/app/controllers/SectorController.js'
import SectorService from '../../src/app/services/SectorService.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function response() {
  return { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
}

test('sector route mutations reuse session middleware and require admin; no client actor/time accepted', () => {
  const routes = fs.readFileSync(path.join(root, 'src/routes.js'), 'utf8')
  assert.match(routes, /routes\.use\(authMiddlewares\)/)
  assert.match(routes, /routes\.put\('\/users\/:userId\/sectors\/:sectorId', requireAdmin/)
  assert.match(routes, /routes\.delete\('\/users\/:userId\/sectors\/:sectorId', requireAdmin/)
  const service = fs.readFileSync(path.join(root, 'src/app/services/SectorService.js'), 'utf8')
  assert.match(service, /actor\.role !== 'admin'/)
  assert.match(service, /actor_user_id: actor\.id/)
  assert.doesNotMatch(service, /request\.body\.actor|request\.body\.occurred_at/)
})

test('grant/revoke validate a non-empty bounded reason and ignore untrusted actor/time fields', async () => {
  const originalGrant = SectorService.grant
  const originalRevoke = SectorService.revoke
  const captured = []
  SectorService.grant = async (...args) => { captured.push(args); return { granted: true } }
  SectorService.revoke = async (...args) => { captured.push(args); return { revoked: true } }
  try {
    const req = { userId: 'admin1', userRole: 'admin', params: { userId: 'target', sectorId: 's1' }, body: { reason: ' approved ', actor_user_id: 'attacker', occurred_at: '1900-01-01' } }
    const grantResponse = response()
    await SectorController.grant(req, grantResponse)
    assert.equal(grantResponse.code, 201)
    assert.deepEqual(captured[0], [{ id: 'admin1', role: 'admin' }, 'target', 's1', 'approved'])

    const revokeResponse = response()
    await SectorController.revoke(req, revokeResponse)
    assert.equal(revokeResponse.code, 200)
    assert.deepEqual(captured[1], [{ id: 'admin1', role: 'admin' }, 'target', 's1', 'approved'])

    const invalidResponse = response()
    await SectorController.grant({ ...req, body: { reason: '   ' } }, invalidResponse)
    assert.equal(invalidResponse.code, 400)
    assert.equal(captured.length, 2)
  } finally {
    SectorService.grant = originalGrant
    SectorService.revoke = originalRevoke
  }
})