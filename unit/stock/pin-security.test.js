import assert from 'node:assert/strict'
import test from 'node:test'
import argon2 from 'argon2'
import {
  createQrToken, hashPin, isValidPin, pinAttemptScopes, pinLookupDigest, safeEqualHex,
  tokenDigest, verifyPin,
} from '../../src/app/services/pinSecurity.js'

process.env.PIN_LOOKUP_SECRET = 'test-only-pin-lookup-secret-with-more-than-32-bytes'

test('PIN format, HMAC lookup digest, and Argon2 verification never expose plaintext', async () => {
  assert.equal(isValidPin('001234'), true)
  assert.equal(isValidPin('12345'), false)
  assert.equal(isValidPin('1234567'), false)
  const lookup = pinLookupDigest('001234')
  const hash = await hashPin('001234')
  assert.match(lookup, /^[a-f0-9]{64}$/)
  assert.match(hash, /^\$argon2id\$/)
  assert.notEqual(lookup, '001234')
  assert.equal(await verifyPin('001234', hash), true)
  assert.equal(await verifyPin('999999', hash), false)
  assert.equal(await verifyPin('001234', await argon2.hash('001234', { type: argon2.argon2id })), true)
})

test('PIN lookup requires an independent server secret and digests are deterministic and scoped', () => {
  const previous = process.env.PIN_LOOKUP_SECRET
  const authSecret = process.env.SECRET_KAY
  process.env.SECRET_KAY = 'independent-authentication-secret'
  process.env.PIN_LOOKUP_SECRET = process.env.SECRET_KAY
  assert.throws(() => pinLookupDigest('123456'), /independent/)
  process.env.PIN_LOOKUP_SECRET = 'test-only-pin-lookup-secret-with-more-than-32-bytes'
  const a = pinLookupDigest('123456')
  const b = pinLookupDigest('123457')
  assert.notEqual(a, b)
  assert.equal(pinAttemptScopes(a, '192.0.2.1')[0], pinAttemptScopes(a, '192.0.2.2')[0])
  assert.notEqual(pinAttemptScopes(a, '192.0.2.1')[1], pinAttemptScopes(a, '192.0.2.2')[1])
  assert.equal(safeEqualHex(tokenDigest('token'), tokenDigest('token')), true)
  assert.equal(safeEqualHex(tokenDigest('token'), tokenDigest('other')), false)
  const qr = createQrToken()
  assert.ok(qr.length >= 40)
  if (previous === undefined) delete process.env.PIN_LOOKUP_SECRET
  else process.env.PIN_LOOKUP_SECRET = previous
  if (authSecret === undefined) delete process.env.SECRET_KAY
  else process.env.SECRET_KAY = authSecret
})