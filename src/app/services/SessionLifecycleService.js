import { randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import authConfig from '../../config/auth.js'
import Database from '../../database/index.js'
import AuthSessionRepository from '../repositories/AuthSessionRepository.js'
import AuthSessionRefreshTokenRepository from '../repositories/AuthSessionRefreshTokenRepository.js'
import { hashRefreshToken, SESSION_TTL_MS } from './sessionSecurity.js'
import { csrfTokenForSession } from './sessionSecurity.js'
import UserRepository from '../repositories/UserRepository.js'

class SessionLifecycleService {
  async refresh(refreshToken, expectedSessionId) {
    if (typeof refreshToken !== 'string' || !refreshToken) throw new Error('Invalid refresh token')
    const tokenHash = hashRefreshToken(refreshToken)
    const result = await Database.connection.transaction(async (transaction) => {
      const storedToken = await AuthSessionRefreshTokenRepository.findByHash(tokenHash, { transaction })
      if (!storedToken) throw new Error('Invalid refresh token')
      const session = await AuthSessionRepository.findByIdForUpdate(storedToken.session_id, transaction)
      if (!session) throw new Error('Invalid refresh token')
      if (expectedSessionId && session.id !== expectedSessionId) throw new Error('Invalid refresh token')
      const subject = session.actor_type === 'user' ? session.user_id : session.client_id
      const user = session.actor_type === 'user'
        ? await UserRepository.findById(subject, { transaction })
        : null
      if (session.actor_type === 'user' && !user) throw new Error('Session owner no longer exists')

      const now = new Date()
      if (storedToken.consumed_at || storedToken.revoked_at) {
        await AuthSessionRepository.revoke(session.id, 'refresh_reuse', transaction)
        await AuthSessionRefreshTokenRepository.revokeActiveForSession(session.id, now, transaction)
        return { error: 'Refresh token reuse detected' }
      }
      if (session.revoked_at || new Date(session.expires_at) <= now) return { error: 'Session expired or revoked' }

      const [consumed] = await AuthSessionRefreshTokenRepository.consume(storedToken.id, now, transaction)
      if (consumed !== 1) {
        await AuthSessionRepository.revoke(session.id, 'refresh_reuse', transaction)
        await AuthSessionRefreshTokenRepository.revokeActiveForSession(session.id, now, transaction)
        return { error: 'Refresh token reuse detected' }
      }

      const nextRefreshToken = randomBytes(32).toString('base64url')
      await AuthSessionRefreshTokenRepository.create({
        id: randomUUID(), session_id: session.id, token_hash: hashRefreshToken(nextRefreshToken),
        created_at: now, consumed_at: null, revoked_at: null,
      }, { transaction })
      await AuthSessionRepository.updateLastUsed(session.id, now, transaction)
      const accessToken = jwt.sign({ sub: subject, sid: session.id, actor_type: session.actor_type, role: session.actor_type === 'client' ? 'client' : user.role }, authConfig.secret, { expiresIn: 15 * 60 })
      return { accessToken, refreshToken: nextRefreshToken, sessionId: session.id, expiresAt: session.expires_at, csrfToken: csrfTokenForSession(session.id) }
    })
    if (result.error) throw new Error(result.error)
    return result
  }

  async logout(sessionId) {
    if (!sessionId) return false
    return Database.connection.transaction(async (transaction) => {
      const session = await AuthSessionRepository.findByIdForUpdate(sessionId, transaction)
      if (!session || session.revoked_at) return false
      const now = new Date()
      await AuthSessionRepository.revoke(session.id, 'logout', transaction)
      await AuthSessionRefreshTokenRepository.revokeActiveForSession(session.id, now, transaction)
      return true
    })
  }
}

export default new SessionLifecycleService()