import * as Yup from 'yup';
import SessionClientService from '../services/SessionClientService.js';

class SessionClientController {
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
      const token = await SessionClientService.loginClient({ email, password });
      return response.json({ token });
    } catch (error) {
      return response.status(401).json({ error: 'Invalid credentials' });
    }

  }

}

export default new SessionClientController();
