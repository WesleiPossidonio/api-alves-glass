import Database from '../../database/index.js'

class PinRepository {
  findByLookup(pinLookup, transaction) {
    return Database.models.User.findOne({ where: { pin_lookup: pinLookup, pin_revoked_at: null, status_users: 'active' }, transaction })
  }

  async validatePin({ pinLookup, pinScope, originScope, now, verify }) {
    return Database.connection.transaction(async transaction => {
      const scopes = [pinScope, originScope].sort()
      for (const scope of scopes) {
        await Database.connection.query('SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0)) AS locked', {
          replacements: { scope }, type: 'SELECT', transaction,
        })
        await Database.connection.query(
          'INSERT INTO pin_attempts(scope_hash, window_started_at, failures) VALUES(:scope, :now, 0) ON CONFLICT(scope_hash) DO NOTHING',
          { replacements: { scope, now }, transaction },
        )
      }
      const attempts = await Database.models.PinAttempt.findAll({
        where: { scope_hash: scopes }, transaction, lock: transaction.LOCK.UPDATE, raw: true,
      })
      const [pinAttempt, originAttempt] = [pinScope, originScope].map(scope => attempts.find(attempt => attempt.scope_hash === scope))
      const blocked = [pinAttempt, originAttempt].some(attempt =>
        attempt?.blocked_until && new Date(attempt.blocked_until) > now)
      if (blocked) {
        return { ok: false, blocked: true, user: null }
      }

      const user = await this.findByLookup(pinLookup, transaction)
      if (user) await user.reload({ transaction, lock: transaction.LOCK.UPDATE })
      const valid = Boolean(user?.pin_hash && await verify(user.pin_hash))
      for (const scope of [pinScope, originScope]) {
        if (valid) {
          await Database.connection.query('DELETE FROM pin_attempts WHERE scope_hash = :scope', {
            replacements: { scope }, transaction,
          })
          continue
        }
        const isPinScope = scope === pinScope
        const failureWindowMs = isPinScope ? 15 * 60_000 : 60 * 60_000
        await Database.connection.query(`
          UPDATE pin_attempts SET
              window_started_at = CASE WHEN window_started_at <= :boundary THEN :now ELSE window_started_at END,
              failures = CASE WHEN window_started_at <= :boundary THEN 1 ELSE LEAST(5, failures + 1) END,
              blocked_until = CASE
                WHEN :isPinScope AND window_started_at > :boundary AND failures + 1 >= 5 THEN :blockedUntil
                WHEN window_started_at <= :boundary THEN NULL
                ELSE blocked_until END
            WHERE scope_hash = :scope`, { replacements: {
            scope, now, isPinScope,
            boundary: new Date(now.getTime() - failureWindowMs),
            blockedUntil: new Date(now.getTime() + 15 * 60_000),
          }, transaction })
      }
      return valid ? { ok: true, user } : { ok: false, blocked: false, user: null }
    })
  }

  clearAttempts(scopeHashes, transaction) {
    return Database.models.PinAttempt.destroy({ where: { scope_hash: scopeHashes }, transaction })
  }

  audit(data, transaction) { return Database.models.PinCredentialAudit.create(data, { transaction }) }

}

export default new PinRepository()