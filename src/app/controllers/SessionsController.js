import * as Yup from 'yup';
import SessionUserService from '../services/SessionUserService.js';
import { csrfCookieOptions } from '../services/sessionSecurity.js'

class SessionController {
  async store (request, response) {
    const schema = Yup.object().shape({
      email: Yup.string().email().required(),
      password: Yup.string().required(),
    });

    const { email, password } = request.body ?? {};

    if (!(await schema.isValid({ email, password }))) {
      return response.status(401).json({
        error: 'Invalid credentials',
      });
    }

    try {
      const session = await SessionUserService.loginUser({
        email,
        password,
      });

      return response
        .cookie('access_token', session.accessToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: 15 * 60 * 1000,
        })
        .cookie('refresh_token', session.refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/session',
          maxAge: 7 * 24 * 60 * 60 * 1000,
        })
        .cookie('csrf_token', session.csrfToken, csrfCookieOptions(7 * 24 * 60 * 60 * 1000))
        .json({
          authenticated: true,
        });

    } catch {
      return response.status(401).json({
        error: 'Invalid credentials',
      });
    }
  }

}

export default new SessionController();
