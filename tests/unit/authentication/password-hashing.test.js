import assert from 'node:assert/strict'
import bcrypt from 'bcrypt'
import test from 'node:test'
import { ARGON2ID_OPTIONS, hashPassword, validatePassword } from '../../../src/app/services/passwordHashing.js'

test('Argon2id hashes are verifiable and reject incorrect passwords', async () => {
  const hash = await hashPassword('test-password')
  assert.match(hash, /^\$argon2id\$/)
  assert.equal(await validatePassword('test-password', hash), true)
  assert.equal(await validatePassword('wrong-password', hash), false)
  assert.equal(ARGON2ID_OPTIONS.memoryCost, 19456)
  assert.equal(ARGON2ID_OPTIONS.timeCost, 2)
  assert.equal(ARGON2ID_OPTIONS.parallelism, 1)
})

test('legacy bcrypt is accepted only through explicit verifier and is never reinterpreted as Argon2', async () => {
  const legacyHash = await bcrypt.hash('legacy-password', 4)
  assert.equal(await validatePassword('legacy-password', legacyHash), false)
  assert.equal(await validatePassword('legacy-password', legacyHash, {
    legacyVerifier: (password, hash) => bcrypt.compare(password, hash),
  }), true)
  assert.equal(await validatePassword('wrong', legacyHash, {
    legacyVerifier: (password, hash) => bcrypt.compare(password, hash),
  }), false)
})