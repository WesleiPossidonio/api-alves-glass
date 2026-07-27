
import * as Yup from 'yup'
import SessionGoogleService from '../services/SessionGoogleService.js';
import verifyGoogleToken from '../../config/googleAuth.js'


class GoogleSessionController {
  async store(request, response) {
    const schema = Yup.object().shape({
        token: Yup.string().matches(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/,
        'Invalid JWT format').required('JWT is required'),
    })
    
    const { token } = req.body;

    try {
      const payload = await verifyGoogleToken(token);
      const { email, name, sub } = payload;
  
      const dataClient = {
        email,
        name,
        googleId: sub
      }

      try {
        const SessionData = SessionGoogleService(dataClient)
        return response.status(200).json(SessionData);
      } catch (err) {
        return response.status(400).json({error: err})
      }
    } catch (err) {
      return response.status(500).response({erro: err})
    }
  }
}

export default new GoogleSessionController()