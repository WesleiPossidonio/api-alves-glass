import assert from 'node:assert/strict'
import test from 'node:test'
import { authorize, requireAdmin, requireClient } from '../../../src/app/meddleawares/authorize.js'

function response() {
  return { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
}

test('authorization distinguishes missing identity (401 upstream) from forbidden actor/role (403)', () => {
  const guard = requireAdmin
  const res = response(); let continued = false
  guard({ actorType: 'user', userRole: 'user' }, res, () => { continued = true })
  assert.equal(res.code, 403); assert.equal(continued, false)
  const adminRes = response(); guard({ actorType: 'user', userRole: 'admin' }, adminRes, () => { continued = true })
  assert.equal(continued, true)
  const clientRes = response(); requireClient({ actorType: 'client' }, clientRes, () => { continued = true })
  assert.equal(continued, true)
  const crossType = response(); requireAdmin({ actorType: 'client', userRole: 'admin' }, crossType, () => {})
  assert.equal(crossType.code, 403)
  const generic = authorize(); const genericRes = response(); generic({ actorType: 'user', userRole: 'user' }, genericRes, () => { continued = true })
  assert.equal(genericRes.code, 200)
})

test('an authenticated admin is the only actor allowed to create internal users', () => {
  const guard = authorize({ actorTypes: ['user'], roles: ['admin'] })
  const unauthenticated = response(); let continued = false
  guard({ actorType: undefined }, unauthenticated, () => { continued = true })
  assert.equal(unauthenticated.code, 403)
  assert.equal(continued, false)
  const client = response()
  guard({ actorType: 'client', userRole: 'admin' }, client, () => { continued = true })
  assert.equal(client.code, 403)
})