import UserRepository from '../repositories/UserRepository.js'
import AuthSessionRepository from '../repositories/AuthSessionRepository.js'
import AuthSessionRefreshTokenRepository from '../repositories/AuthSessionRefreshTokenRepository.js'
import Database from '../../database/index.js'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import authConfig from '../../config/auth.js'
import { csrfTokenForSession } from './sessionSecurity.js'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
function hashRefreshToken(token) { return createHash('sha256').update(token).digest('hex') }

class SessionUserService {
  async loginUser({ email, password }) {
    try {
      const user = await UserRepository.findByEmail(email)
      if (!user || user.status_users !== 'active') {
        throw new Error('Invalid credentials')
      }
      const validPassword = await user.checkPassword(password)
      if (!validPassword) throw new Error('Invalid credentials')

      const createdAt = new Date()
      const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS)
      const refreshToken = randomBytes(32).toString('base64url')

      return await Database.connection.transaction(async (transaction) => {
        const session = await AuthSessionRepository.create({
          id: randomUUID(),
          user_id: user.id,
          client_id: null,
          actor_type: 'user',
          created_at: createdAt,
          expires_at: expiresAt,
          last_used_at: createdAt,
          revoked_at: null,
          revocation_reason: null,
        }, { transaction })

        await AuthSessionRefreshTokenRepository.create({
          id: randomUUID(),
          session_id: session.id,
          token_hash: hashRefreshToken(refreshToken),
          created_at: createdAt,
          consumed_at: null,
          revoked_at: null,
        }, { transaction })

        const accessToken = jwt.sign({ sub: user.id, sid: session.id, actor_type: 'user', role: user.role }, authConfig.secret, { expiresIn: 15 * 60 })
        return { accessToken, refreshToken, sessionId: session.id, expiresAt: session.expires_at, csrfToken: csrfTokenForSession(session.id) }
      })
    } catch {
      throw new Error('Invalid credentials')
    }
  }
}

export default new SessionUserService()
