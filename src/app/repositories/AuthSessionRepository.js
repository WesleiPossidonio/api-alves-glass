import AuthSession from '../models/AuthSession.js'
import { randomUUID } from 'node:crypto'

class AuthSessionRepository {
  create(sessionData, options = {}) {
    return AuthSession.create({ id: randomUUID(), ...sessionData }, { transaction: options.transaction })
  }

  findActiveById(id, options = {}) {
    return AuthSession.findOne({
      where: { id, revoked_at: null },
      transaction: options.transaction,
    })
  }

  findByIdForUpdate(id, transaction) {
    return AuthSession.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE })
  }

  revoke(id, reason, transaction) {
    return AuthSession.update({ revoked_at: new Date(), revocation_reason: reason }, { where: { id, revoked_at: null }, transaction })
  }

  updateLastUsed(id, at, transaction) {
    return AuthSession.update({ last_used_at: at }, { where: { id, revoked_at: null }, transaction })
  }
}

export default new AuthSessionRepository()