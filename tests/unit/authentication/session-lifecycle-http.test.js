import assert from 'node:assert/strict'
import test from 'node:test'
import { csrfTokenForSession } from '../../../src/app/services/sessionSecurity.js'
import LifecycleController from '../../../src/app/controllers/SessionLifecycleController.js'
import LifecycleService from '../../../src/app/services/SessionLifecycleService.js'
import RefreshRepository from '../../../src/app/repositories/AuthSessionRefreshTokenRepository.js'
import jwt from 'jsonwebtoken'
import authConfig from '../../../src/config/auth.js'
import { createServer } from 'node:http'

async function post(handler, path, { cookies = {}, headers = {}, onCookie } = {}) {
  const server = createServer(async (req, res) => {
    req.cookies = cookies
    req.get = (name) => headers[name.toLowerCase()]
    const response = {
      status(code) { res.statusCode = code; return this },
      cookie(name, value, options) { const line = `${name}=${value}; Path=${options.path}; ${options.httpOnly ? 'HttpOnly;' : ''} Max-Age=${options.maxAge}`; res.appendHeader('Set-Cookie', line); onCookie?.(name, line); return this },
      json(body) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return this },
    }
    await handler(req, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try { const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST' }); return { status: r.status, body: await r.json(), cookies: r.headers.getSetCookie() } }
  finally { await new Promise((resolve) => server.close(resolve)) }
}

test('refresh and logout HTTP require allowed Origin plus session-bound CSRF and rotate/clear cookies', async () => {
  const sid = 'session-http-test'; const csrf = csrfTokenForSession(sid)
  const access = jwt.sign({ sid, sub: 'subject', actor_type: 'user' }, authConfig.secret, { expiresIn: 600 })
  const originalRefresh = LifecycleService.refresh; const originalLogout = LifecycleService.logout; const originalLookup = RefreshRepository.findSessionIdByHash
  LifecycleService.refresh = async (_token, sessionId) => ({ sessionId, accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: new Date(Date.now() + 100000), csrfToken: csrf })
  LifecycleService.logout = async () => true
  RefreshRepository.findSessionIdByHash = async () => ({ session_id: sid })
  const cookies = { access_token: access, refresh_token: 'old-refresh', csrf_token: csrf }
  const headers = { origin: 'http://localhost:5173', 'x-csrf-token': csrf }
  try {
    const denied = await post(LifecycleController.refresh.bind(LifecycleController), '/session/refresh', { cookies, headers: { ...headers, origin: 'https://attacker.example' } })
    assert.equal(denied.status, 403)
    const expiredAccess = jwt.sign({ sid, sub: 'subject', actor_type: 'user' }, authConfig.secret, { expiresIn: -1 })
    const refreshed = await post(LifecycleController.refresh.bind(LifecycleController), '/session/refresh', { cookies: { ...cookies, access_token: expiredAccess }, headers })
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.cookies.length, 3)
    const clearedCookies = []
    const logout = await post(LifecycleController.logout.bind(LifecycleController), '/session/logout', { cookies, headers, onCookie: (_name, line) => clearedCookies.push(line) })
    assert.equal(logout.status, 200)
    assert.equal(logout.body.authenticated, false)
    assert.equal(logout.cookies.length, 3)
    assert.ok(logout.cookies.every((cookie) => /Max-Age=0/.test(cookie)))
    assert.match(clearedCookies.find((cookie) => cookie.startsWith('csrf_token=')), /Path=\//)
  } finally {
    LifecycleService.refresh = originalRefresh; LifecycleService.logout = originalLogout; RefreshRepository.findSessionIdByHash = originalLookup
  }
})