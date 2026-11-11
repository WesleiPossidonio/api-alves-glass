import { createHash, randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import authConfig from '../../config/auth.js'
import Database from '../../database/index.js'
import AuthSessionRepository from '../repositories/AuthSessionRepository.js'
import AuthSessionRefreshTokenRepository from '../repositories/AuthSessionRefreshTokenRepository.js'
import ClientRepository from '../repositories/ClientRepository.js'
import { csrfTokenForSession } from './sessionSecurity.js'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const hashRefreshToken = (token) => createHash('sha256').update(token).digest('hex')

class SessionClientService {
  async loginClient({ email, password }) {
    const client = await ClientRepository.findByEmail(email)
    if (!client || client.client_status !== 'active' || !(await client.checkPassword(password))) {
      throw new Error('Invalid credentials')
    }
    return this.createSession(client, 'password')
  }

  async loginClientWithGoogle({ googleId }) {
    if (!googleId) throw new Error('Invalid credentials')
    const client = await ClientRepository.findByGoogleId(googleId)
    if (!client || client.client_status !== 'active') throw new Error('Invalid credentials')
    return this.createSession(client, 'google')
  }

  async createSession(client, method) {
    const createdAt = new Date()
    const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS)
    const refreshToken = randomBytes(32).toString('base64url')
    return Database.connection.transaction(async (transaction) => {
      const session = await AuthSessionRepository.create({
        id: randomUUID(), user_id: null, client_id: client.id, actor_type: 'client',
        created_at: createdAt, expires_at: expiresAt, last_used_at: createdAt,
        revoked_at: null, revocation_reason: null,
      }, { transaction })
      await AuthSessionRefreshTokenRepository.create({
        id: randomUUID(), session_id: session.id, token_hash: hashRefreshToken(refreshToken),
        created_at: createdAt, consumed_at: null, revoked_at: null,
      }, { transaction })
      const accessToken = jwt.sign({ sub: client.id, sid: session.id, actor_type: 'client', role: 'client', auth_method: method }, authConfig.secret, { expiresIn: 15 * 60 })
      return { accessToken, refreshToken, sessionId: session.id, expiresAt: session.expires_at, csrfToken: csrfTokenForSession(session.id) }
    })
  }
}

export default new SessionClientService()