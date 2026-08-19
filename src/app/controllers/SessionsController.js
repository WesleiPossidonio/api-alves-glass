import * as Yup from 'yup';
import jwt from 'jsonwebtoken'
import authConfig from '../../config/auth.js';

import SessionUserService from '../services/SessionUserService.js';
import User from '../models/User.js';
import Client from '../models/Client.js'

class SessionController {
  async store (request, response) {
    const schema = Yup.object().shape({
      email: Yup.string().email().required(),
      password: Yup.string().required(),
    });

    const { email, password } = request.body;

    if (!(await schema.isValid({ email, password }))) {
      return response.status(401).json({
        error: 'Invalid credentials',
      });
    }

    try {
      const token = await SessionUserService.loginClient({
        email,
        password,
      });

      console.log('TOKEN GERADO:', token);
      console.log('TIPO:', typeof token);

      return response
        .cookie('token', token, {
          httpOnly: true,
          secure: false, // true em produção com HTTPS
          sameSite: 'lax',
          maxAge: 1000 * 60 * 60 * 24, // 1 dia
        })
        .json({
          authenticated: true,
        });

    } catch (error) {
      return response.status(401).json({
        error: 'Invalid credentials',
      });
    }
  }

 async index(request, response) {
  const { userId, userRole } = request;

  let user = null;
  let client = null;

  if (userRole === 'admin') {
    user = await User.findByPk(userId, {
      attributes: ['id', 'name', 'email'],
    });
  }

  if (userRole === 'client') {
    client = await Client.findByPk(userId, {
      attributes: ['id', 'name', 'email'],
    });
  }

  if (!user && !client) {
    return response.status(401).json({
      error: 'User not found',
    });
  }

  return response.status(200).json({
    role: userRole,
    user,
    client,
  });
}
}

export default new SessionController();
