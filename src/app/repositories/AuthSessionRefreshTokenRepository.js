import AuthSessionRefreshToken from '../models/AuthSessionRefreshToken.js'
import { randomUUID } from 'node:crypto'

class AuthSessionRefreshTokenRepository {
  create(tokenData, options = {}) {
    return AuthSessionRefreshToken.create({ id: randomUUID(), ...tokenData }, { transaction: options.transaction })
  }

  findCurrentBySessionId(sessionId, options = {}) {
    return AuthSessionRefreshToken.findOne({
      where: { session_id: sessionId, consumed_at: null, revoked_at: null },
      transaction: options.transaction,
    })
  }

  findByHash(tokenHash, options = {}) {
    return AuthSessionRefreshToken.findOne({ where: { token_hash: tokenHash }, transaction: options.transaction })
  }

  findSessionIdByHash(tokenHash) {
    return AuthSessionRefreshToken.findOne({ where: { token_hash: tokenHash }, attributes: ['session_id'] })
  }

  consume(id, consumedAt, transaction) {
    return AuthSessionRefreshToken.update({ consumed_at: consumedAt }, { where: { id, consumed_at: null, revoked_at: null }, transaction })
  }

  revokeActiveForSession(sessionId, revokedAt, transaction) {
    return AuthSessionRefreshToken.update({ revoked_at: revokedAt }, { where: { session_id: sessionId, revoked_at: null }, transaction })
  }
}

export default new AuthSessionRefreshTokenRepository()