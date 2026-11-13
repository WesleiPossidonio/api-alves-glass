import assert from 'node:assert/strict'
import cookieParser from 'cookie-parser'
import express from 'express'
import test from 'node:test'
import { createServer } from 'node:http'
import jwt from 'jsonwebtoken'
import authConfig from '../../src/config/auth.js'

if (!authConfig.secret) authConfig.secret = 'test-only-session-signing-secret-not-for-production'
import AuthSessionRepository from '../../src/app/repositories/AuthSessionRepository.js'
import UserRepository from '../../src/app/repositories/UserRepository.js'
import SectorService from '../../src/app/services/SectorService.js'
import routes from '../../src/routes.js'
import { csrfTokenForSession } from '../../src/app/services/sessionSecurity.js'

async function startServer() {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(routes)
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server
}

function sessionCookies(actor, sid) {
  const token = jwt.sign({ sid, sub: actor.id, actor_type: 'user' }, authConfig.secret, { expiresIn: 600 })
  return { access_token: token, csrf_token: csrfTokenForSession(sid) }
}

function cookieHeader(cookies) {
  return Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ')
}

test('sector routes enforce real HTTP authentication, role, CSRF, and scoped non-enumeration', async () => {
  const originals = {
    activeSession: AuthSessionRepository.findActiveById,
    user: UserRepository.findById,
    listSectors: SectorService.listSectors,
    listWarehouses: SectorService.listWarehouses,
    grant: SectorService.grant,
    revoke: SectorService.revoke,
  }
  const actors = new Map([
    ['admin-id', { id: 'admin-id', role: 'admin' }],
    ['user-id', { id: 'user-id', role: 'user' }],
  ])
  AuthSessionRepository.findActiveById = async sid => ({
    id: sid,
    expires_at: new Date(Date.now() + 60_000),
    actor_type: 'user',
    user_id: sid === 'admin-session' ? 'admin-id' : 'user-id',
  })
  UserRepository.findById = async id => actors.get(id)
  SectorService.listSectors = async actor => actor.role === 'admin' ? [{ id: 's1' }, { id: 's2' }] : [{ id: 's1' }]
  SectorService.listWarehouses = async (actor, sectorId) => {
    if (actor.role !== 'admin' && sectorId !== 's1') return null
    return { sector: { id: sectorId }, warehouses: [{ id: 'w1', sector_id: sectorId }] }
  }
  SectorService.grant = async actor => actor.role === 'admin' ? { granted: true } : { forbidden: true }
  SectorService.revoke = async actor => actor.role === 'admin' ? { revoked: true } : { forbidden: true }

  const server = await startServer()
  const base = `http://127.0.0.1:${server.address().port}`
  const adminCookies = sessionCookies(actors.get('admin-id'), 'admin-session')
  const userCookies = sessionCookies(actors.get('user-id'), 'user-session')
  const fetchWith = (path, { cookies, ...options } = {}) => fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(cookies ? { cookie: cookieHeader(cookies) } : {}),
      ...options.headers,
    },
  })

  try {
    assert.equal((await fetchWith('/sectors')).status, 401)

    const userSectors = await fetchWith('/sectors', { cookies: userCookies })
    assert.equal(userSectors.status, 200)
    assert.deepEqual((await userSectors.json()).sectors, [{ id: 's1' }])

    const allowedWarehouse = await fetchWith('/sectors/s1/warehouses', { cookies: userCookies })
    assert.equal(allowedWarehouse.status, 200)
    const hiddenWarehouse = await fetchWith('/sectors/s2/warehouses', { cookies: userCookies })
    assert.equal(hiddenWarehouse.status, 404)
    assert.deepEqual(await hiddenWarehouse.json(), { error: 'Resource not found' })

    const deniedGrant = await fetchWith('/users/user-id/sectors/s1', {
      method: 'PUT', cookies: userCookies,
      headers: { origin: 'http://localhost:5173', 'x-csrf-token': userCookies.csrf_token },
      body: JSON.stringify({ reason: 'approved' }),
    })
    assert.equal(deniedGrant.status, 403)

    const unauthenticatedRevoke = await fetchWith('/users/user-id/sectors/s1', {
      method: 'DELETE',
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'approved' }),
    })
    assert.equal(unauthenticatedRevoke.status, 401)

    const missingCsrf = await fetchWith('/users/user-id/sectors/s1', {
      method: 'PUT', cookies: adminCookies,
      headers: { origin: 'http://localhost:5173' },
      body: JSON.stringify({ reason: 'approved' }),
    })
    assert.equal(missingCsrf.status, 403)

    const invalidOrigin = await fetchWith('/users/user-id/sectors/s1', {
      method: 'PUT', cookies: adminCookies,
      headers: { origin: 'https://attacker.example', 'x-csrf-token': adminCookies.csrf_token },
      body: JSON.stringify({ reason: 'approved' }),
    })
    assert.equal(invalidOrigin.status, 403)

    const granted = await fetchWith('/users/user-id/sectors/s1', {
      method: 'PUT', cookies: adminCookies,
      headers: { origin: 'http://localhost:5173', 'x-csrf-token': adminCookies.csrf_token },
      body: JSON.stringify({ reason: 'approved' }),
    })
    assert.equal(granted.status, 201)
    assert.deepEqual(await granted.json(), { granted: true })

    const revoked = await fetchWith('/users/user-id/sectors/s1', {
      method: 'DELETE', cookies: adminCookies,
      headers: { origin: 'http://localhost:5173', 'x-csrf-token': adminCookies.csrf_token },
      body: JSON.stringify({ reason: 'revoked by admin' }),
    })
    assert.equal(revoked.status, 200)
    assert.deepEqual(await revoked.json(), { revoked: true })
  } finally {
    await new Promise(resolve => server.close(resolve))
    AuthSessionRepository.findActiveById = originals.activeSession
    UserRepository.findById = originals.user
    SectorService.listSectors = originals.listSectors
    SectorService.listWarehouses = originals.listWarehouses
    SectorService.grant = originals.grant
    SectorService.revoke = originals.revoke
  }
})