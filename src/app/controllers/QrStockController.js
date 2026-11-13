import * as Yup from 'yup'
import QrStockService from '../services/QrStockService.js'

const pinSchema = Yup.object({ pin: Yup.string().matches(/^\d{6}$/).required() }).noUnknown()
const withdrawalSchema = Yup.object({
  token: Yup.string().min(40).max(64), materialId: Yup.string().uuid(), code: Yup.string().trim().min(1).max(64),
  quantity: Yup.string().required(), operationId: Yup.string().uuid().required(), pin: Yup.string().matches(/^\d{6}$/).required(),
}).noUnknown().test('one-material-reference', 'Provide exactly one material reference', value => [value?.token, value?.materialId, value?.code].filter(Boolean).length === 1)

function sendError(response, result) {
  const status = result.error === 'notFound' ? 404 : result.error === 'forbidden' ? 403
    : ['insufficientBalance', 'idempotencyConflict', 'pinConflict'].includes(result.error) ? 409
      : ['invalidPin', 'unavailable'].includes(result.error) ? 401 : 400
  return response.status(status).json({ error: result.error })
}

class QrStockController {
  async publicResolve(request, response) {
    const result = await QrStockService.resolve(request.params.token, { withBalance: false, ipAddress: request.ip || request.socket?.remoteAddress })
    if (result.error === 'rateLimited') return response.status(429).json({ error: 'Rate limit exceeded' })
    return result.error ? response.status(404).json({ error: 'Resource not found' }) : response.json(result)
  }
  async resolve(request, response) {
    let body
    try { body = await pinSchema.validate(request.query, { abortEarly: false, stripUnknown: false }) }
    catch (error) { return response.status(400).json({ error: error.errors }) }
    const result = await QrStockService.resolveForPin(request.params.token, body.pin, request.ip || request.socket?.remoteAddress)
    if (result.error) return response.status(result.error === 'invalidPin' ? 401 : 404).json({ error: 'Invalid PIN or unavailable material' })
    return result.error ? response.status(404).json({ error: 'Invalid PIN or unavailable material' }) : response.json(result)
  }
  async manualResolveByCode(request, response) {
    let body
    try { body = await pinSchema.validate(request.query, { abortEarly: false, stripUnknown: false }) }
    catch (error) { return response.status(400).json({ error: error.errors }) }
    const result = await QrStockService.manualResolveByCode({ code: request.params.code, pin: body.pin, ipAddress: request.ip || request.socket?.remoteAddress })
    if (result.error) return response.status(result.error === 'invalidPin' ? 401 : 404).json({ error: 'Invalid PIN or unavailable material' })
    return result.error ? response.status(404).json({ error: 'Invalid PIN or unavailable material' }) : response.json(result)
  }
  async withdraw(request, response) {
    let body
    try { body = await withdrawalSchema.validate(request.body, { abortEarly: false, stripUnknown: false }) }
    catch (error) { return response.status(400).json({ error: error.errors }) }
    const idempotencyKey = request.get('Idempotency-Key')
    if (!idempotencyKey) return response.status(400).json({ error: 'Idempotency-Key is required' })
    const result = await QrStockService.withdraw({ ...body, idempotencyKey, ipAddress: request.ip || request.socket?.remoteAddress })
    if (['rateLimited', 'invalidPin', 'notFound', 'forbidden', 'unavailable'].includes(result.error)) {
      const status = result.error === 'rateLimited' ? 429 : 401
      return response.status(status).json({ error: 'Invalid PIN or unavailable material' })
    }
    return result.error ? sendError(response, result) : response.status(201).json(result)
  }
  async issue(request, response) {
    const result = await QrStockService.issue({ id: request.userId, role: request.userRole }, request.params.materialId)
    return result.error ? sendError(response, result) : response.status(201).json(result)
  }
  async revoke(request, response) {
    const result = await QrStockService.revoke({ id: request.userId, role: request.userRole }, request.params.materialId)
    return result.error ? sendError(response, result) : response.status(204).end()
  }
}
export default new QrStockController()
