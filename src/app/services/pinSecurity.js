import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import bcrypt from 'bcrypt'

function lookupSecret() {
  const secret = process.env.PIN_LOOKUP_SECRET
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('PIN_LOOKUP_SECRET must contain at least 32 bytes')
  if (secret === process.env.SECRET_KAY) throw new Error('PIN_LOOKUP_SECRET must be independent from authentication secrets')
  return secret
}
export const PIN_WINDOW_MS = 15 * 60_000
export const PIN_BLOCK_MS = 15 * 60_000
export const PIN_MAX_FAILURES = 5

export function isValidPin(pin) { return typeof pin === 'string' && /^\d{6}$/.test(pin) }

export function pinLookupDigest(pin) {
  return createHmac('sha256', lookupSecret()).update(`stock-pin:v1:${pin}`).digest('hex')
}

export async function hashPin(pin) {
  if (!isValidPin(pin)) throw new TypeError('PIN must contain exactly six digits')
  return argon2.hash(pin, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
}

export async function verifyPin(pin, encodedHash) {
  if (!isValidPin(pin) || typeof encodedHash !== 'string') return false
  try {
    if (encodedHash.startsWith('$argon2id$')) return await argon2.verify(encodedHash, pin)
    if (/^\$2[aby]\$/.test(encodedHash)) return await bcrypt.compare(pin, encodedHash)
    return false
  } catch { return false }
}

export function pinAttemptScopes(pinLookup, ipAddress) {
  const ip = typeof ipAddress === 'string' && ipAddress.length <= 128 ? ipAddress : 'unknown'
  return [
    pinUserAttemptScope(pinLookup),
    pinOriginAttemptScope(ip),
  ]
}

export function pinUserAttemptScope(pinLookup) { return createHash('sha256').update(`pin-user:${pinLookup}`).digest('hex') }
export function pinOriginAttemptScope(ipAddress) {
  const ip = typeof ipAddress === 'string' && ipAddress.length <= 128 ? ipAddress : 'unknown'
  return createHash('sha256').update(`pin-origin:${ip}`).digest('hex')
}

export function tokenDigest(token) { return createHash('sha256').update(token).digest('hex') }
export function createQrToken() { return randomBytes(32).toString('base64url') }

export function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false
  const a = Buffer.from(left, 'hex'); const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}