import assert from 'node:assert/strict'
import cookieParser from 'cookie-parser'
import express from 'express'
import test from 'node:test'
import { createServer } from 'node:http'
import jwt from 'jsonwebtoken'
import authConfig from '../../src/config/auth.js'
import AuthSessionRepository from '../../src/app/repositories/AuthSessionRepository.js'
import UserRepository from '../../src/app/repositories/UserRepository.js'
import MaterialCatalogService from '../../src/app/services/MaterialCatalogService.js'
import routes from '../../src/routes.js'
import { csrfTokenForSession } from '../../src/app/services/sessionSecurity.js'


test('material catalog HTTP routes enforce authentication, sector scope, CSRF, and initial quantity contract', async () => {
  if (!authConfig.secret) authConfig.secret = 'test-only-session-signing-secret-not-for-production'
  const originals = {
    session: AuthSessionRepository.findActiveById,
    user: UserRepository.findById,
    listCategories: MaterialCatalogService.listCategories,
    createCategory: MaterialCatalogService.createCategory,
    listMaterials: MaterialCatalogService.listMaterials,
    createMaterial: MaterialCatalogService.createMaterial,
  }
  const actors = new Map([
    ['catalog-admin', { id: 'catalog-admin', role: 'admin' }],
    ['catalog-user', { id: 'catalog-user', role: 'user' }],
  ])
  AuthSessionRepository.findActiveById = async sid => ({ id: sid, expires_at: new Date(Date.now() + 60_000), actor_type: 'user', user_id: sid === 'admin-session' ? 'catalog-admin' : 'catalog-user' })
  UserRepository.findById = async id => actors.get(id)
  MaterialCatalogService.listCategories = async (_actor, warehouseId) => warehouseId === 'warehouse-allowed' ? [{ id: 'category-1' }] : null
  MaterialCatalogService.createCategory = async (_actor, _warehouseId, body) => ({ id: 'category-1', ...body })
  MaterialCatalogService.listMaterials = async (_actor, warehouseId) => warehouseId === 'warehouse-allowed' ? [] : null
  MaterialCatalogService.createMaterial = async (_actor, _warehouseId, body) => ({ id: 'material-1', ...body })

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(routes)
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const makeCookies = (actor, sid) => ({ access_token: jwt.sign({ sid, sub: actor.id, actor_type: 'user' }, authConfig.secret, { expiresIn: 600 }), csrf_token: csrfTokenForSession(sid) })
  const cookies = makeCookies(actors.get('catalog-user'), 'user-session')
  const cookieHeader = Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ')
  const request = (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.cookies ? { cookie: Object.entries(options.cookies).map(([key, value]) => `${key}=${value}`).join('; ') } : {}), ...options.headers } })

  try {
    assert.equal((await request('/warehouses/warehouse-allowed/categories')).status, 401)
    assert.equal((await request('/warehouses/warehouse-allowed/categories', { headers: { cookie: cookieHeader } })).status, 200)
    const hidden = await request('/warehouses/warehouse-outside/categories', { headers: { cookie: cookieHeader } })
    assert.equal(hidden.status, 404)
    assert.deepEqual(await hidden.json(), { error: 'Resource not found' })
    assert.equal((await request('/warehouses/warehouse-outside/materials', { headers: { cookie: cookieHeader } })).status, 404)

    const noCsrf = await request('/warehouses/warehouse-allowed/categories', { method: 'POST', headers: { cookie: cookieHeader, origin: 'http://localhost:5173' }, body: JSON.stringify({ name: 'Electrical' }) })
    assert.equal(noCsrf.status, 403)
    const csrfHeaders = { cookie: cookieHeader, origin: 'http://localhost:5173', 'x-csrf-token': cookies.csrf_token }
    const createdCategory = await request('/warehouses/warehouse-allowed/categories', { method: 'POST', headers: csrfHeaders, body: JSON.stringify({ name: 'Electrical' }) })
    assert.equal(createdCategory.status, 201)
    const materialWithLegacyBalance = await request('/warehouses/warehouse-allowed/materials', {
      method: 'POST', headers: csrfHeaders,
      body: JSON.stringify({ code: 'M-1', name: 'Part', category_id: '00000000-0000-4000-8000-000000000001', unit_code: 'un', initialQuantity: '10', balance: '10' }),
    })
    assert.equal(materialWithLegacyBalance.status, 400)
    const materialWithoutInitialQuantity = await request('/warehouses/warehouse-allowed/materials', {
      method: 'POST', headers: csrfHeaders,
      body: JSON.stringify({ code: 'M-2', name: 'Part', category_id: '00000000-0000-4000-8000-000000000001', unit_code: 'un' }),
    })
    assert.equal(materialWithoutInitialQuantity.status, 400)

    const materialWithInitialQuantity = await request('/warehouses/warehouse-allowed/materials', {
      method: 'POST', headers: csrfHeaders,
      body: JSON.stringify({ code: 'M-3', name: 'Part with opening', category_id: '00000000-0000-4000-8000-000000000001', unit_code: 'kg', initialQuantity: '1.250' }),
    })
    assert.equal(materialWithInitialQuantity.status, 201)
    assert.equal((await materialWithInitialQuantity.json()).material.initialQuantity, '1.250')
  } finally {
    await new Promise(resolve => server.close(resolve))
    AuthSessionRepository.findActiveById = originals.session
    UserRepository.findById = originals.user
    MaterialCatalogService.listCategories = originals.listCategories
    MaterialCatalogService.createCategory = originals.createCategory
    MaterialCatalogService.listMaterials = originals.listMaterials
    MaterialCatalogService.createMaterial = originals.createMaterial
  }
})