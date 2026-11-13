import assert from 'node:assert/strict'
import test from 'node:test'
import Database from '../../src/database/index.js'
import PinCredentialService from '../../src/app/services/PinCredentialService.js'
import PinRepository from '../../src/app/repositories/PinRepository.js'
import UserRepository from '../../src/app/repositories/UserRepository.js'
import { pinLookupDigest } from '../../src/app/services/pinSecurity.js'

process.env.PIN_LOOKUP_SECRET = 'test-only-pin-lookup-secret-with-more-than-32-bytes'

test('PIN credential administration is admin-only and reports collisions without exposing secrets', async () => {
  const originals = {
    transaction: Database.connection.transaction, user: UserRepository.findById,
    findOne: Database.models.User.findOne, audit: PinRepository.audit, clear: PinRepository.clearAttempts,
    query: Database.connection.query,
  }
  const tx = { LOCK: { UPDATE: 'UPDATE' } }
  const saved = []
  try {
    Database.connection.transaction = async callback => callback(tx)
    Database.connection.query = async () => {}
    UserRepository.findById = async () => ({ id: 'user-1', status_users: 'active', pin_lookup: null, update: async values => saved.push(values) })
    Database.models.User.findOne = async ({ where }) => where.pin_lookup === pinLookupDigest('123456') ? { id: 'user-2' } : null
    PinRepository.audit = async () => { throw new Error('collision should not audit') }
    PinRepository.clearAttempts = async () => {}
    assert.deepEqual(await PinCredentialService.set({ id: 'user-1', role: 'user' }, 'user-1', '123456', 'SET', 'approved setup'), { error: 'forbidden' })
    assert.deepEqual(await PinCredentialService.set({ id: 'admin-1', role: 'admin' }, 'user-1', '123456', 'SET', 'approved setup'), { error: 'pinConflict' })
    assert.deepEqual(saved, [])
  } finally {
    Database.connection.transaction = originals.transaction
    UserRepository.findById = originals.user
    Database.models.User.findOne = originals.findOne
    Database.connection.query = originals.query
    PinRepository.audit = originals.audit
    PinRepository.clearAttempts = originals.clear
  }
})

test('PIN validation uses generic error and counts unknown PIN failures per account-key and origin', async () => {
  const original = PinRepository.validatePin
  const counted = []
  try {
    PinRepository.validatePin = async ({ pinScope, originScope }) => { counted.push([pinScope, originScope]); return { ok: false } }
    const result = await PinCredentialService.validate('999999', '198.51.100.4')
    assert.deepEqual(result, { error: 'invalidPin' })
    assert.equal(counted.length, 1)
    assert.equal(counted[0].length, 2)
  } finally { PinRepository.validatePin = original }
})