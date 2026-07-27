import * as Yup from 'yup';
import jwt from 'jsonwebtoken'
import authConfig from '../../config/auth.js';
import User from '../models/User.js';
import Client from '../models/Client.js';
import SessionUserService from '../services/SessionUserService.js';

class SessionController {
  async store (request, response) {
    const schema = Yup.object().shape({
      email: Yup.string().email().required(),
      password: Yup.string().required(),
    });

    const { email, password } = request.body;

    if (!(await schema.isValid({ email, password }))) {
      return response.status(401).json({ error: 'Invalid credentials' });
    }

    try {
      const token = await SessionUserService.loginClient({ email, password });
      return response.json({ token });
    } catch (error) {
      return response.status(401).json({ error: 'Invalid credentials' });
    }

    return response.status(401).json({ error: 'Invalid credentials' });
  }

  async index (request, response) {
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      return response.status(401).json({ error: 'Token not provided' });
    }

    const [, token] = authHeader.split(' ');

    try {
      const decoded = jwt.verify(token, authConfig.secret);
      const { id, role } = decoded;

      let user;
      if (role === 'admin') {
        user = await User.findByPk(id);
      }

      if (!user) {
        return response.status(401).json({ error: 'User not found' });
      }

      return response.status(200).json({
        message: 'Authenticated',
      });
      
    } catch (err) {
      return response.status(401).json({ error: 'Token is invalid or expired' });
    }
  }
}

export default new SessionController();
