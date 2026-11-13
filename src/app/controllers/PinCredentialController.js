import * as Yup from 'yup'
import PinCredentialService from '../services/PinCredentialService.js'

const schema = Yup.object({ reason: Yup.string().trim().min(1).max(500).required() }).noUnknown()
const actor = request => ({ id: request.userId, role: request.userRole })

class PinCredentialController {
  async set(request, response) {
    let body
    try {
      body = await schema.concat(Yup.object({ pin: Yup.string().matches(/^\d{6}$/).required() })).validate(request.body, { abortEarly: false, stripUnknown: false })
    }
    catch (error) { return response.status(400).json({ error: error.errors }) }
    const result = await PinCredentialService.set(actor(request), request.params.userId, body.pin, request.method === 'PUT' ? 'RESET' : 'SET', body.reason)
    if (result.error) return response.status(result.error === 'forbidden' ? 403 : result.error === 'notFound' ? 404 : result.error === 'pinConflict' ? 409 : 400).json({ error: result.error })
    return response.status(204).end()
  }

  async revoke(request, response) {
    let body
    try { body = await schema.validate(request.body, { abortEarly: false, stripUnknown: false }) }
    catch (error) { return response.status(400).json({ error: error.errors }) }
    const result = await PinCredentialService.revoke(actor(request), request.params.userId, body.reason)
    if (result.error) return response.status(result.error === 'forbidden' ? 403 : 404).json({ error: result.error })
    return response.status(204).end()
  }
}

export default new PinCredentialController()