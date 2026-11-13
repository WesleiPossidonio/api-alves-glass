import Database from '../../database/index.js'
import PinRepository from '../repositories/PinRepository.js'
import UserRepository from '../repositories/UserRepository.js'
import { hashPin, isValidPin, pinAttemptScopes, pinLookupDigest, pinUserAttemptScope, tokenDigest, verifyPin } from './pinSecurity.js'
import QrPublicRateLimitRepository from '../repositories/QrPublicRateLimitRepository.js'

const fail = error => ({ error })
const now = () => new Date()
const QR_MAX_REQUESTS = 5
const QR_WINDOW_MS = 60_000

class PinCredentialService {
  async set(actor, userId, pin, action = 'SET', reason = 'Administrative PIN credential change') {
    if (actor?.role !== 'admin' || !actor.id) return fail('forbidden')
    if (!isValidPin(pin) || !['SET', 'RESET'].includes(action) || typeof reason !== 'string' || !reason.trim() || reason.length > 500 || reason.includes(pin)) return fail('validation')
    let pinLookup
    try { pinLookup = pinLookupDigest(pin) } catch { return fail('configuration') }
    const pinHash = await hashPin(pin)
    try {
      return await Database.connection.transaction(async transaction => {
        await Database.connection.query('SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0))', { replacements: { scope: `user-pin:${userId}` }, transaction })
        const user = await UserRepository.findById(userId, { transaction, lock: transaction.LOCK.UPDATE })
        if (!user || user.status_users !== 'active') return fail('notFound')
        const collision = await Database.models.User.findOne({ where: { pin_lookup: pinLookup, pin_revoked_at: null, status_users: 'active' }, transaction, lock: transaction.LOCK.UPDATE })
        if (collision && collision.id !== user.id) return fail('pinConflict')
        if (user.pin_lookup) await PinRepository.clearAttempts([pinUserAttemptScope(user.pin_lookup)], transaction)
        await user.update({ pin_lookup: pinLookup, pin_hash: pinHash, pin_revoked_at: null }, { transaction })
        await PinRepository.clearAttempts([pinUserAttemptScope(pinLookup)], transaction)
        await PinRepository.audit({ user_id: user.id, actor_user_id: actor.id, action, reason, occurred_at: now() }, transaction)
        return { changed: true }
      })
    } catch (error) {
      if (error.original?.code === '23505' || error.name === 'SequelizeUniqueConstraintError') return fail('pinConflict')
      throw error
    }
  }

  async revoke(actor, userId, reason = 'Administrative PIN revocation') {
    if (actor?.role !== 'admin' || !actor.id) return fail('forbidden')
    return Database.connection.transaction(async transaction => {
      await Database.connection.query('SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0))', { replacements: { scope: `user-pin:${userId}` }, transaction })
      const user = await UserRepository.findById(userId, { transaction, lock: transaction.LOCK.UPDATE })
      if (!user) return fail('notFound')
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) return fail('validation')
      if (user.pin_lookup) await PinRepository.clearAttempts([pinUserAttemptScope(user.pin_lookup)], transaction)
      await user.update({ pin_hash: null, pin_lookup: null, pin_revoked_at: now() }, { transaction })
      await PinRepository.audit({ user_id: user.id, actor_user_id: actor.id, action: 'REVOKE', reason, occurred_at: now() }, transaction)
      return { changed: true }
    })
  }

  async validate(pin, ipAddress) {
    if (!isValidPin(pin)) return fail('invalidPin')
    let lookup
    try { lookup = pinLookupDigest(pin) } catch { return fail('unavailable') }
    const [pinScope, originScope] = pinAttemptScopes(lookup, ipAddress)
    const result = await PinRepository.validatePin({
      pinLookup: lookup, pinScope, originScope, now: now(),
      verify: hash => verifyPin(pin, hash),
    })
    return result.ok ? { id: result.user.id, role: result.user.role, pinLookup: lookup } : fail('invalidPin')
  }

  async allowPublicResolve(ipAddress) {
    const origin = typeof ipAddress === 'string' && ipAddress.length <= 128 ? ipAddress : 'unknown'
    return QrPublicRateLimitRepository.consume(tokenDigest(`qr-public-origin:v1:${origin}`), now(), QR_WINDOW_MS, QR_MAX_REQUESTS)
  }
}

export default new PinCredentialService()
