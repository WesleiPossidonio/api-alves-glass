import * as Yup from 'yup';
import jwt from 'jsonwebtoken';
import authConfig from '../../config/auth.js';
import User from '../models/User.js';
import Client from '../models/Client.js';

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

    // Tenta achar admin
    const user = await User.findOne({ where: { email: email.trim() } });

    if (user && (await user.checkPassword(password))) {
      const token = jwt.sign(
        { id: user.id, role: 'admin' },
        authConfig.secret,
        { expiresIn: authConfig.expiresIn }
      );

      return response.json({
        token,
        name: user.name,
        email: user.email,
        role: 'admin',
      });
    }

    // Tenta achar client
    const client = await Client.findOne({ where: { email: email.trim() } });

    if (client && (await client.checkPassword(password))) {
      const token = jwt.sign(
        { id: client.id, role: 'client' },
        authConfig.secret,
        { expiresIn: authConfig.expiresIn }
      );

      return response.json({
        token,
        name: client.name,
        email: client.email,
        number_client: client.number_client,
        role: 'client',
      });
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
      } else if (role === 'client') {
        user = await Client.findByPk(id);
      }

      if (!user) {
        return response.status(401).json({ error: 'User not found' });
      }

      return response.status(200).json({
        message: 'Authenticated',
        userId: user.id,
        name: user.name,
        role,
      });
    } catch (err) {
      return response.status(401).json({ error: 'Token is invalid or expired' });
    }
  }
}

export default new SessionController();
