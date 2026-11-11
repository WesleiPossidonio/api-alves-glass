import * as Yup from 'yup'
import SessionGoogleService from '../services/SessionGoogleService.js'
import verifyGoogleToken from '../../config/googleAuth.js'
import { csrfCookieOptions } from '../services/sessionSecurity.js'

class GoogleSessionController {
  async store(request, response) {
    const schema = Yup.object({ token: Yup.string().required() })
    const { token } = request.body ?? {}
    if (!(await schema.isValid({ token }))) {
      return response.status(401).json({ error: 'Invalid Google credentials' })
    }

    try {
      const payload = await verifyGoogleToken(token)
      if (!payload?.sub) return response.status(401).json({ error: 'Invalid Google credentials' })
      const session = await SessionGoogleService.loginClient({ sub: payload.sub })
      return response
        .cookie('access_token', session.accessToken, {
          httpOnly: true, secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax', path: '/', maxAge: 15 * 60 * 1000,
        })
        .cookie('refresh_token', session.refreshToken, {
          httpOnly: true, secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax', path: '/session', maxAge: 7 * 24 * 60 * 60 * 1000,
        })
        .cookie('csrf_token', session.csrfToken, csrfCookieOptions(7 * 24 * 60 * 60 * 1000))
        .json({ authenticated: true })
    } catch {
      return response.status(401).json({ error: 'Invalid Google credentials' })
    }
  }
}

export default new GoogleSessionController()