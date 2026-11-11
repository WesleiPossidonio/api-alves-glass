import argon2 from 'argon2'

export const ARGON2ID_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
})

export async function hashPassword(password) {
  return argon2.hash(password, ARGON2ID_OPTIONS)
}

export async function validatePassword(password, passwordHash, { legacyVerifier } = {}) {
  if (typeof passwordHash !== 'string') return false
  if (passwordHash.startsWith('$argon2id$')) return argon2.verify(passwordHash, password)
  if (passwordHash.startsWith('$argon2')) return false
  if (typeof legacyVerifier === 'function' && /^\$2[aby]\$/.test(passwordHash)) {
    return legacyVerifier(password, passwordHash)
  }
  return false
}