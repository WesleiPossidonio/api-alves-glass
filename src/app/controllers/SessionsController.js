import * as Yup from 'yup';
import jwt from 'jsonwebtoken'
import authConfig from '../../config/auth.js';

import SessionUserService from '../services/SessionUserService.js';
import User from '../models/User.js';
import Client from '../models/Client.js'

class SessionController {
async store(request, response) {
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
  const token = request.cookies.token;

  if (!token) {
    return response.status(401).json({
      error: "Token not provided",
    });
  }

  try {
    const decoded = jwt.verify(token, authConfig.secret);

    const { id, role } = decoded;

    let user = null;
    let client = null;

    if (role === "admin") {
      user = await User.findByPk(id, {
        attributes: ["id", "name", "email"],
      });
    }

    if (role === "client") {
      client = await Client.findByPk(id, {
        attributes: ["id", "name", "email"],
      });
    }

    if (!user && !client) {
      return response.status(401).json({
        error: "User not found",
      });
    }

    return response.status(200).json({
      role,
      user,
      client,
    });

  } catch (err) {
    return response.status(401).json({
      error: "Token is invalid or expired",
    });
  }
}
}

export default new SessionController();
