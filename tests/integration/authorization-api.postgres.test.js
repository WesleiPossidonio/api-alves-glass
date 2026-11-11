import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import app from '../../src/app.js'
import Database from '../../src/database/index.js'
import User from '../../src/app/models/User.js'
import Client from '../../src/app/models/Client.js'
import Order from '../../src/app/models/Order.js'
import AuthSession from '../../src/app/models/AuthSession.js'
import AuthSessionRefreshToken from '../../src/app/models/AuthSessionRefreshToken.js'

test('real HTTP authorization: role, actor separation, ownership, rate limit, refresh expiry and logout revocation', { skip: process.env.RUN_POSTGRES_AUTH_INTEGRATION !== '1' }, async () => {
  const suffix = randomUUID(); const password = `authz-${suffix}`
  let admin; let regular; let clientA; let clientB; let order; let server
  const sessions = []
  try {
    admin = await User.create({ name: `Admin ${suffix}`, email: `admin-${suffix}@example.test`, password, role: 'admin' })
    regular = await User.create({ name: `User ${suffix}`, email: `user-${suffix}@example.test`, password, role: 'user' })
    const addr = { phone: '555', cep: '00000', rua: 'Rua', number_house: '1', bairro: 'Bairro', cidade: 'Cidade', uf: 'SP' }
    clientA = await Client.create({ ...addr, name: `Client A ${suffix}`, email: `a-${suffix}@example.test`, password, client_status: 'active' })
    clientB = await Client.create({ ...addr, name: `Client B ${suffix}`, email: `b-${suffix}@example.test`, password, client_status: 'active' })
    order = await Order.create({ order_number: suffix, client_id: clientB.id, status: 'open', status_description: 'test', total: 100 })
    server = app.listen(0, '0.0.0.0'); await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const base = `http://127.0.0.1:${server.address().port}`
    assert.equal((await fetch(`${base}/check-auth`)).status, 401)
    const login = async (path, email) => {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
      return { status: r.status, cookie: r.headers.getSetCookie() }
    }
    const cookieJar = (lines) => Object.fromEntries(lines.map((x) => [x.slice(0, x.indexOf('=')).split(';')[0], x.slice(x.indexOf('=') + 1, x.indexOf(';'))]))
    const request = (path, jar, method = 'GET', body) => fetch(`${base}${path}`, { method, headers: { cookie: Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '), origin: 'http://localhost:5173', 'x-csrf-token': jar.csrf_token, ...(body ? { 'content-type':'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const adminLogin = await login('/session/user', admin.email); const userLogin = await login('/session/user', regular.email)
    const clientLogin = await login('/session/client', clientA.email)
    assert.equal(adminLogin.status, 200); assert.equal(userLogin.status, 200); assert.equal(clientLogin.status, 200)
    const adminJar = cookieJar(adminLogin.cookie); const userJar = cookieJar(userLogin.cookie); const clientJar = cookieJar(clientLogin.cookie)
    for (const jar of [adminJar, userJar, clientJar]) sessions.push((await import('jsonwebtoken')).default.decode(jar.access_token).sid)
    const roleForbidden = await request('/user/all', userJar); assert.equal(roleForbidden.status, 403)
    const typeForbidden = await request('/client/me', userJar); assert.equal(typeForbidden.status, 403)
    const clientBLogin = await login('/session/client', clientB.email); const clientBJar = cookieJar(clientBLogin.cookie)
    const ownedDenied = await request('/order/me', clientJar); assert.equal(ownedDenied.status, 200)
    const ownedList = await ownedDenied.json(); assert.equal(ownedList.length, 0)
    const adminAllowed = await request('/user/all', adminJar); assert.equal(adminAllowed.status, 200)
    const clientsDenied = await request('/client/me', clientJar); assert.equal(clientsDenied.status, 200)
    const clientBOrders = await request('/order/me', clientBJar)
    assert.equal(clientBOrders.status, 200)
    const clientBOrderList = await clientBOrders.json()
    assert.equal(clientBOrderList.some((item) => item.id === order.id), true)

    const unauthenticatedCreate = await fetch(`${base}/createUser`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `No auth ${suffix}`, email: `noauth-${suffix}@example.test`, password, role: 'admin' }) })
    assert.equal(unauthenticatedCreate.status, 401)
    const userCreate = await request('/createUser', userJar, 'POST', { name: `Denied ${suffix}`, email: `denied-${suffix}@example.test`, password, role: 'admin' })
    assert.equal(userCreate.status, 403)
    const adminCreate = await request('/createUser', adminJar, 'POST', { name: `Created ${suffix}`, email: `created-${suffix}@example.test`, password, role: 'admin' })
    assert.equal(adminCreate.status, 201)

    const access = userJar.access_token
    const decoded = (await import('jsonwebtoken')).default.decode(access)
    sessions.push(decoded.sid)
    const expired = (await import('jsonwebtoken')).default.sign({ sub: regular.id, sid: decoded.sid, actor_type: 'user', role: 'user' }, process.env.SECRET_KAY, { expiresIn: -1 })
    const expiredJar = { ...userJar, access_token: expired }
    const refreshResponse = await request('/session/refresh', expiredJar, 'POST')
    assert.equal(refreshResponse.status, 200)
    const updated = cookieJar(refreshResponse.headers.getSetCookie())
    const refreshedClaims = (await import('jsonwebtoken')).default.decode(updated.access_token)
    sessions.push(refreshedClaims.sid)
    const stillValidBeforeLogout = await request('/check-auth', updated)
    assert.equal(stillValidBeforeLogout.status, 200)
    const logoutResponse = await request('/session/logout', updated, 'POST')
    assert.equal(logoutResponse.status, 200)
    const afterLogout = await request('/check-auth', updated)
    assert.equal(afterLogout.status, 401)

    const rateResponses = []
    for (let i=0; i<6; i++) rateResponses.push(await fetch(`${base}/session/user`, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ email:`none-${suffix}@example.test`, password:'bad' }) }))
    assert.equal(rateResponses.at(-1).status, 429)
    assert.ok(Number(rateResponses.at(-1).headers.get('retry-after')) > 0)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (sessions.length) {
      await AuthSessionRefreshToken.destroy({ where: { session_id: sessions } })
      await AuthSession.destroy({ where: { id: sessions } })
    }
    if (order) await order.destroy()
    for (const email of [`noauth-${suffix}@example.test`, `denied-${suffix}@example.test`, `created-${suffix}@example.test`]) await User.destroy({ where: { email } })
    for (const model of [admin, regular, clientA, clientB]) if (model) await model.destroy()
    await Database.connection.close()
  }
})