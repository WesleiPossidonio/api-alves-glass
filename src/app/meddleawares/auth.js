import Jwt from 'jsonwebtoken'
import authConfig from '../../config/auth.js'
import AuthSessionRepository from '../repositories/AuthSessionRepository.js'
import { isAllowedOrigin, verifyCsrfToken } from '../services/sessionSecurity.js'
import UserRepository from '../repositories/UserRepository.js'

export default async (request, response, next) => {
  const token = request.cookies?.access_token ?? request.cookies?.token

  if (!token) {
    return response.status(401).json({ 
      error: 'Token not provided' 
    })
  }

  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
  if (isMutation) {
    const csrfHeader = request.get('x-csrf-token')
    if (!isAllowedOrigin(request.get('origin')) || !csrfHeader || csrfHeader !== request.cookies?.csrf_token) {
      return response.status(403).json({ error: 'CSRF validation failed' })
    }
  }

  try {
    const decoded = Jwt.verify(token, authConfig.secret)

    if (decoded.sid) {
      const session = await AuthSessionRepository.findActiveById(decoded.sid)
      if (!session || new Date(session.expires_at) <= new Date() || session.actor_type !== decoded.actor_type) {
        return response.status(401).json({ error: 'Session is invalid' })
      }
      const actorId = decoded.actor_type === 'user' ? session.user_id : session.client_id
      if (actorId !== decoded.sub) return response.status(401).json({ error: 'Session is invalid' })
      if (isMutation && !verifyCsrfToken(decoded.sid, request.get('x-csrf-token'))) {
        return response.status(403).json({ error: 'CSRF validation failed' })
      }
    } else {
      return response.status(401).json({ error: 'Session is invalid' })
    }

    request.userId = decoded.sub ?? decoded.id
    request.userRole = decoded.actor_type === 'user'
      ? (await UserRepository.findById(request.userId))?.role
      : 'client'
    if (decoded.actor_type === 'user' && !request.userRole) return response.status(401).json({ error: 'Session owner is invalid' })
    request.user = { id: request.userId, role: request.userRole }
    request.actorType = decoded.actor_type ?? (decoded.role === 'client' ? 'client' : 'user')
    request.sessionId = decoded.sid

    return next()

  } catch {
    return response.status(401).json({ 
      error: 'Token is invalid' 
    })
  }
}