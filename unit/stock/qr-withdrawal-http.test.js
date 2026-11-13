import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import cookieParser from 'cookie-parser'
import { createServer } from 'node:http'
import routes from '../../src/routes.js'
import QrStockService from '../../src/app/services/QrStockService.js'
import PinCredentialService from '../../src/app/services/PinCredentialService.js'
import AuthSessionRepository from '../../src/app/repositories/AuthSessionRepository.js'
import UserRepository from '../../src/app/repositories/UserRepository.js'
import jwt from 'jsonwebtoken'
import authConfig from '../../src/config/auth.js'

if (!authConfig.secret) authConfig.secret = 'test-only-session-signing-secret-not-for-production'
import { csrfTokenForSession } from '../../src/app/services/sessionSecurity.js'

async function serverWithMocks(t) {
  const originalWithdraw = QrStockService.withdraw
  const originalSet = PinCredentialService.set
  QrStockService.withdraw = async input => {
    assert.equal(input.pin, '123456')
    return { event: { id: 'event-1', withdrawn_by: 'user-1', authorized_by: 'user-1', performed_by: null }, balance: '1' }
  }
  PinCredentialService.set = async () => ({ changed: true })
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(routes)
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    QrStockService.withdraw = originalWithdraw
    PinCredentialService.set = originalSet
  })
  return `http://127.0.0.1:${server.address().port}`
}

test('POST /stock/withdrawals is sessionless while admin PIN routes still require session', async t => {
  const base = await serverWithMocks(t)
  const withdrawal = await fetch(`${base}/stock/withdrawals`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'http-unit-1' },
    body: JSON.stringify({ materialId: '5eaa4f26-79ba-46a2-b1ed-ec56bc02af4c', operationId: '9f8216ab-4014-4c32-870e-15c6cc35cb19', quantity: '1', pin: '123456' }),
  })
  assert.equal(withdrawal.status, 201, await withdrawal.clone().text())
  assert.equal((await withdrawal.json()).event.authorized_by, 'user-1')

  const adminRoute = await fetch(`${base}/users/5eaa4f26-79ba-46a2-b1ed-ec56bc02af4c/pin`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '111111', reason: 'test' }),
  })
  assert.equal(adminRoute.status, 401)
})

test('admin PIN operation is still guarded by requireAdmin after authentication', async t => {
  const base = await serverWithMocks(t)
  const oldSession = AuthSessionRepository.findActiveById
  const oldUser = UserRepository.findById
  AuthSessionRepository.findActiveById = async sid => ({ id: sid, expires_at: new Date(Date.now() + 60_000), actor_type: 'user', user_id: 'ordinary-user' })
  UserRepository.findById = async id => ({ id, role: 'user' })
  t.after(() => { AuthSessionRepository.findActiveById = oldSession; UserRepository.findById = oldUser })
  const sid = 'ordinary-session'
  const access = jwt.sign({ sid, sub: 'ordinary-user', actor_type: 'user' }, authConfig.secret, { expiresIn: 300 })
  const response = await fetch(`${base}/users/5eaa4f26-79ba-46a2-b1ed-ec56bc02af4c/pin`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `access_token=${access}; csrf_token=${csrfTokenForSession(sid)}`, origin: 'http://localhost:5173', 'x-csrf-token': csrfTokenForSession(sid) },
    body: JSON.stringify({ pin: '111111', reason: 'test' }),
  })
  assert.equal(response.status, 403)
})

test('PIN, material, sector, and replay authorization failures share a non-enumerating HTTP response', async t => {
  const base = await serverWithMocks(t)
  for (const error of ['invalidPin', 'notFound', 'forbidden', 'rateLimited']) {
    QrStockService.withdraw = async () => ({ error })
    const response = await fetch(`${base}/stock/withdrawals`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'http-unit-2' },
      body: JSON.stringify({ materialId: '5eaa4f26-79ba-46a2-b1ed-ec56bc02af4c', operationId: '9f8216ab-4014-4c32-870e-15c6cc35cb19', quantity: '1', pin: '123456' }),
    })
    assert.equal(response.status, error === 'rateLimited' ? 429 : 401)
    assert.deepEqual(await response.json(), { error: 'Invalid PIN or unavailable material' })
  }
})

test('withdrawal route is ordered before the global session middleware', async () => {
  const source = await import('node:fs/promises')
  const routesSource = await source.readFile(new URL('../../src/routes.js', import.meta.url), 'utf8')
  assert.ok(routesSource.indexOf("routes.post('/stock/withdrawals'") < routesSource.indexOf('routes.use(authMiddlewares)'))
  assert.match(routesSource, /routes\.post\('\/users\/\:userId\/pin', requireAdmin/)
})