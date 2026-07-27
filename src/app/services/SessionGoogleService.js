import jwt from 'jsonwebtoken';
import ClientRepository from "../repositories/ClientRepository.js";
import authConfig from '../../config/auth.js'

class SessionGoogleService {
  async loginClient(clientDataLogin) {

    const {email, name, googleId} = clientDataLogin
    const existClient = await ClientRepository.findByEmail(email)

    if (!existClient) {
        throw new Error('Cliente não cadastrado.');
    }

    if (existClient.googleId && existClient.googleId !== googleId) {
        throw new Error('Acesso negado.');
    }

    if (!existClient.googleId) {
      const client = await ClientRepository.updateGoogleId(
        client.id,
        googleId
      );

      const token = jwt.sign(
         { id: client.id, role: client.role },
         authConfig.secret,
         { expiresIn: authConfig.expiresIn }
      )

      return token

    }

  }
}

export default new SessionGoogleService()