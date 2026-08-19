import jwt from 'jsonwebtoken';
import UserRepository from '../repositories/UserRepository.js';
import authConfig from '../../config/auth.js';

class SessionUserService {
  async loginClient({ email, password }) {
    try {
      const user = await UserRepository.findByEmail(email);

      if (!user || !(await user.checkPassword(password))) {
        throw new Error('Credenciais inválidas');
      }

      const token = jwt.sign(
        {
          id: user.id,
          role: user.role,
        },
        authConfig.secret,
        {
          expiresIn: authConfig.expiresIn,
        }
      );

      return token;
    } catch (error) {
      throw new Error(error.message);
    }
  }
}

export default new SessionUserService();