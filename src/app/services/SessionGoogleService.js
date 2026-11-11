import SessionClientService from './SessionClientService.js'

class SessionGoogleService {
  loginClient({ sub }) {
    return SessionClientService.loginClientWithGoogle({ googleId: sub })
  }
}

export default new SessionGoogleService()