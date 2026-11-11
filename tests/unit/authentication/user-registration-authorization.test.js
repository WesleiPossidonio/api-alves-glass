import assert from 'node:assert/strict'
import test from 'node:test'
import UserController from '../../../src/app/controllers/UserController.js'
import UserService from '../../../src/app/services/UserService.js'

function response() { return { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } } }

test('public registration never creates an admin even when request body asks for admin', async () => {
  const original = UserService.registerUser
  let createdData
  UserService.registerUser = async (data) => { createdData = data; return { id: 'u1', name: data.name, email: data.email } }
  try {
    const res = response()
    await UserController.store({ body: { name: 'New user', email: 'new@example.test', password: 'password-123', role: 'admin' }, userRole: undefined }, res)
    assert.equal(res.code, 201)
    assert.equal(createdData.role, 'user')
  } finally { UserService.registerUser = original }
})