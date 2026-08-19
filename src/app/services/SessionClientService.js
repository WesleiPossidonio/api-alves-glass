import jwt from 'jsonwebtoken';
import ClientRepository from "../repositories/ClientRepository.js";
import authConfig from '../../config/auth.js'

class SessionClientService {
  async loginClient (clientDataLogin) {
    const { email, password } = clientDataLogin

    try {
      const client = await ClientRepository.findByEmail(email);

      if (!client || !(await client.checkPassword(password))) {
        throw new Error('Credenciais inválidas');
      }

      const token = jwt.sign(
        {
          id: client.id,
          role: client.role,
        },
        authConfig.secret,
        {
          expiresIn: authConfig.expiresIn,
        }
      );

      return token;
    } catch (error) {
      throw new Error(error)
    }
  }
}

export default new SessionClientService()