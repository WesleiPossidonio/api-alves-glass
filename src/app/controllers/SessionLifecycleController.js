import SessionLifecycleService from '../services/SessionLifecycleService.js'
import { csrfCookieOptions, isAllowedOrigin, verifyCsrfToken } from '../services/sessionSecurity.js'
import jwt from 'jsonwebtoken'
import { hashRefreshToken } from '../services/sessionSecurity.js'
import AuthSessionRefreshTokenRepository from '../repositories/AuthSessionRefreshTokenRepository.js'
import authConfig from '../../config/auth.js'

const clearCookieOptions = (path, httpOnly) => ({ httpOnly, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path, maxAge: 0 })

class SessionLifecycleController {
  csrfValid(request, sessionId) {
    const origin = request.get('origin')
    const headerToken = request.get('x-csrf-token')
    const cookieToken = request.cookies?.csrf_token
    return isAllowedOrigin(origin) && headerToken && cookieToken === headerToken && verifyCsrfToken(sessionId, headerToken)
  }

  async refresh(request, response) {
    const refreshToken = request.cookies?.refresh_token
    if (!refreshToken) return response.status(401).json({ error: 'Invalid refresh token' })
    let accessClaims
    try { accessClaims = jwt.verify(request.cookies?.access_token ?? '', authConfig.secret, { ignoreExpiration: true }) }
    catch { return response.status(401).json({ error: 'Invalid session' }) }
    if (!accessClaims.sid) return response.status(401).json({ error: 'Invalid session' })
    const storedSession = await AuthSessionRefreshTokenRepository.findSessionIdByHash(hashRefreshToken(refreshToken))
    if (!storedSession) return response.status(401).json({ error: 'Invalid refresh token' })
    const sessionId = storedSession.session_id
    if (accessClaims.sid !== sessionId) return response.status(401).json({ error: 'Invalid refresh token' })
    if (!this.csrfValid(request, sessionId)) return response.status(403).json({ error: 'CSRF validation failed' })
    try {
      const session = await SessionLifecycleService.refresh(refreshToken, sessionId)
      return response
        .cookie('access_token', session.accessToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 15 * 60 * 1000 })
        .cookie('refresh_token', session.refreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/session', maxAge: Math.max(0, new Date(session.expiresAt).getTime() - Date.now()) })
        .cookie('csrf_token', session.csrfToken, csrfCookieOptions(Math.max(0, new Date(session.expiresAt).getTime() - Date.now())))
        .json({ authenticated: true })
    } catch { return response.status(401).json({ error: 'Invalid refresh token or session' }) }
  }

  async logout(request, response) {
    let claims
    try { claims = jwt.verify(request.cookies?.access_token ?? '', authConfig.secret, { ignoreExpiration: true }) } catch { claims = null }
    if (!claims?.sid) return response.status(200)
      .cookie('access_token', '', clearCookieOptions('/', true))
      .cookie('refresh_token', '', clearCookieOptions('/session', true))
      .cookie('csrf_token', '', clearCookieOptions('/', false))
      .json({ authenticated: false })
    if (!this.csrfValid(request, claims.sid)) return response.status(403).json({ error: 'CSRF validation failed' })
    await SessionLifecycleService.logout(claims.sid)
    return response
      .cookie('access_token', '', clearCookieOptions('/', true))
      .cookie('refresh_token', '', clearCookieOptions('/session', true))
      .cookie('csrf_token', '', clearCookieOptions('/', false))
      .status(200).json({ authenticated: false })
  }
}

export default new SessionLifecycleController()