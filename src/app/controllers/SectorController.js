import * as Yup from 'yup'
import SectorService from '../services/SectorService.js'

const grantSchema = Yup.object({ reason: Yup.string().trim().min(1).max(500).required() }).noUnknown()

class SectorController {
  async index(request, response) {
    const sectors = await SectorService.listSectors({ id: request.userId, role: request.userRole })
    return response.json({ sectors })
  }

  async warehouses(request, response) {
    const result = await SectorService.listWarehouses(
      { id: request.userId, role: request.userRole }, request.params.sectorId,
    )
    if (!result) return response.status(404).json({ error: 'Resource not found' })
    return response.json({ sector: result.sector, warehouses: result.warehouses })
  }

  async grant(request, response) {
    let body
    try { body = await grantSchema.validate(request.body, { abortEarly: false, stripUnknown: true }) }
    catch (error) { return response.status(400).json({ error: error.errors }) }
    const result = await SectorService.grant(
      { id: request.userId, role: request.userRole }, request.params.userId, request.params.sectorId, body.reason,
    )
    if (result.forbidden) return response.status(403).json({ error: 'Forbidden' })
    if (result.notFound) return response.status(404).json({ error: 'Resource not found' })
    return response.status(result.unchanged ? 200 : 201).json({ granted: true })
  }

  async revoke(request, response) {
    let body
    try { body = await grantSchema.validate(request.body, { abortEarly: false, stripUnknown: true }) }
    catch (error) { return response.status(400).json({ error: error.errors }) }
    const result = await SectorService.revoke(
      { id: request.userId, role: request.userRole }, request.params.userId, request.params.sectorId, body.reason,
    )
    if (result.forbidden) return response.status(403).json({ error: 'Forbidden' })
    if (result.notFound) return response.status(404).json({ error: 'Resource not found' })
    return response.status(200).json({ revoked: Boolean(result.revoked) })
  }
}

export default new SectorController()