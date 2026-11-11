import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import SessionClientController from '../../../src/app/controllers/SessionClientController.js'
import GoogleSessionController from '../../../src/app/controllers/GoogleSessionController.js'
import SessionClientService from '../../../src/app/services/SessionClientService.js'
import SessionGoogleService from '../../../src/app/services/SessionGoogleService.js'
import { OAuth2Client } from 'google-auth-library'

async function httpPost(handler, path, body) {
  const server = createServer(async (request, response) => {
    request.body = body
    const result = {
      status(code) { response.statusCode = code; return this },
      cookie(name, value, options) {
        const cookie = `${name}=${value}; Path=${options.path}; HttpOnly; SameSite=${options.sameSite}${options.secure ? '; Secure' : ''}; Max-Age=${Math.floor(options.maxAge / 1000)}`
        response.appendHeader('Set-Cookie', cookie)
        return this
      },
      json(value) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); return this },
    }
    await handler(request, result)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() }
  } finally { await new Promise((resolve) => server.close(resolve)) }
}

test('Client password HTTP controller emits shared HttpOnly access and refresh cookies', async () => {
  const original = SessionClientService.loginClient
  SessionClientService.loginClient = async () => ({ accessToken: 'access-test', refreshToken: 'refresh-test' })
  try {
    const response = await httpPost(SessionClientController.store.bind(SessionClientController), '/session/client', { email: 'client@example.test', password: 'password' })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { authenticated: true })
    assert.equal(response.cookies.length, 3)
    assert.match(response.cookies[0], /^access_token=.*; Path=\/; HttpOnly/)
    assert.match(response.cookies[1], /^refresh_token=.*; Path=\/session; HttpOnly/)

    SessionClientService.loginClient = async () => { throw new Error('Invalid credentials') }
    const rejected = await httpPost(SessionClientController.store.bind(SessionClientController), '/session/client', { email: 'client@example.test', password: 'wrong' })
    assert.equal(rejected.status, 401)
    assert.deepEqual(rejected.cookies, [])
  } finally { SessionClientService.loginClient = original }
})

test('Google HTTP controller validates identity and only emits cookies for linked subject', async () => {
  const originalLogin = SessionGoogleService.loginClient
  const originalVerify = OAuth2Client.prototype.verifyIdToken
  let expectedSub = 'linked-google-sub'
  SessionGoogleService.loginClient = async ({ sub }) => {
    assert.equal(sub, expectedSub)
    return { accessToken: 'access-test', refreshToken: 'refresh-test' }
  }
  OAuth2Client.prototype.verifyIdToken = async ({ idToken, audience }) => {
    assert.equal(idToken, 'signed-google-id-token')
    assert.ok(audience)
    return { getPayload: () => ({ sub: expectedSub, email: 'same-email@example.test', email_verified: true }) }
  }
  try {
    const linked = await httpPost(GoogleSessionController.store.bind(GoogleSessionController), '/google-session', { token: 'signed-google-id-token' })
    assert.equal(linked.status, 200)
    assert.deepEqual(linked.body, { authenticated: true })
    assert.equal(linked.cookies.length, 3)
    assert.equal(linked.cookies.filter((cookie) => /HttpOnly/.test(cookie)).length, 3)
    expectedSub = 'not-linked-google-sub'
    SessionGoogleService.loginClient = async () => { throw new Error('Invalid credentials') }
    const unlinked = await httpPost(GoogleSessionController.store.bind(GoogleSessionController), '/google-session', { token: 'signed-google-id-token' })
    assert.equal(unlinked.status, 401)
    assert.deepEqual(unlinked.cookies, [])

    OAuth2Client.prototype.verifyIdToken = async () => { throw new Error('Invalid Google Token') }
    const invalid = await httpPost(GoogleSessionController.store.bind(GoogleSessionController), '/google-session', { token: 'invalid-id-token' })
    assert.equal(invalid.status, 401)
    assert.deepEqual(invalid.cookies, [])
  } finally {
    SessionGoogleService.loginClient = originalLogin
    OAuth2Client.prototype.verifyIdToken = originalVerify
  }
})
