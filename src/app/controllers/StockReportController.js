import * as Yup from 'yup'
import StockReportService from '../services/StockReportService.js'

const querySchema = Yup.object({
  from: Yup.string().required(), to: Yup.string().required(), warehouseId: Yup.string().uuid(),
  sectorId: Yup.string().uuid(), materialId: Yup.string().uuid(), type: Yup.string(),
  withdrawnBy: Yup.string().uuid(), receivedBy: Yup.string().uuid(), performedBy: Yup.string().uuid(),
  authorizedBy: Yup.string().uuid(), cursor: Yup.string().max(4096), limit: Yup.number().integer().min(1).max(100),
}).noUnknown()

function actor(request) { return { id: request.userId, role: request.userRole } }
function errorResponse(response, error) {
  if (error === 'forbidden') return response.status(403).json({ error: 'Forbidden' })
  if (error === 'validation') return response.status(400).json({ error: 'Invalid report query' })
  return response.status(500).json({ error: 'Internal server error' })
}

class StockReportController {
  async summary(request, response) {
    let filters
    try { filters = await querySchema.validate(request.query, { abortEarly: false, stripUnknown: false }) }
    catch { return response.status(400).json({ error: 'Invalid report query' }) }
    if (filters.cursor !== undefined || filters.limit !== undefined || filters.type !== undefined ||
      filters.withdrawnBy !== undefined || filters.receivedBy !== undefined || filters.performedBy !== undefined || filters.authorizedBy !== undefined) {
      return response.status(400).json({ error: 'Invalid report query' })
    }
    const result = await StockReportService.summarize(actor(request), filters)
    return result?.error ? errorResponse(response, result.error) : response.json({ data: result })
  }

  async statement(request, response) {
    let filters
    try { filters = await querySchema.validate(request.query, { abortEarly: false, stripUnknown: false }) }
    catch { return response.status(400).json({ error: 'Invalid report query' }) }
    const result = await StockReportService.statement(actor(request), filters)
    return result?.error ? errorResponse(response, result.error) : response.json(result)
  }
}

export default new StockReportController()