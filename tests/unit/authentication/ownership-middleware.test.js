import assert from 'node:assert/strict'
import test from 'node:test'
import Order from '../../../src/app/models/Order.js'
import { requireOwner } from '../../../src/app/meddleawares/ownership.js'

function res() { return { code: 200, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } } }

test('ownership allows matching client and denies another client for persisted order ownership', async () => {
  const original = Order.findByPk
  Order.findByPk = async (id) => id === 'owned-order' ? { client_id: 'client-one' } : { client_id: 'client-two' }
  try {
    let passed = false; const ok = res()
    await requireOwner({ resourceType: 'order' })({ actorType: 'client', userId: 'client-one', params: { id: 'owned-order' } }, ok, () => { passed = true })
    assert.equal(passed, true); assert.equal(ok.code, 200)
    const denied = res()
    await requireOwner({ resourceType: 'order' })({ actorType: 'client', userId: 'client-one', params: { id: 'other-order' } }, denied, () => {})
    assert.equal(denied.code, 403)
  } finally { Order.findByPk = original }
})

test('ownership rejects unsupported resource types and user access without an explicit admin ownership rule', async () => {
  const deniedUser = res()
  await requireOwner({ resourceType: 'budget', roles: ['user'] })({ actorType: 'user', userRole: 'user', userId: 'u1', params: { id: 'u1' } }, deniedUser, () => assert.fail('must reject'))
  assert.equal(deniedUser.code, 403)
  const unsupported = res()
  await requireOwner({ resourceType: 'budget' })({ actorType: 'client', userId: 'c1', params: { id: 'b1' } }, unsupported, () => assert.fail('must reject'))
  assert.equal(unsupported.code, 403)
})