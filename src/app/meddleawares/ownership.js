import Order from '../models/Order.js'
import Client from '../models/Client.js'

export function requireOwner({ param = 'id', roles = [], resourceType } = {}) {
  return async (request, response, next) => {
    const resourceId = request.params?.[param]
    if (request.actorType === 'user') {
      if (!roles.includes(request.userRole) || resourceType !== 'user') return response.status(403).json({ error: 'Forbidden' })
      if (resourceId !== request.userId) return response.status(403).json({ error: 'Forbidden' })
      return next()
    }
    if (request.actorType !== 'client') return response.status(403).json({ error: 'Forbidden' })
    if (!resourceId) return response.status(403).json({ error: 'Forbidden' })
    let resource
    if (resourceType === 'order') resource = await Order.findByPk(resourceId, { attributes: ['client_id'] })
    else if (resourceType === 'client') resource = await Client.findByPk(resourceId, { attributes: ['id'] })
    else return response.status(403).json({ error: 'Forbidden' })
    if (!resource) return response.status(404).json({ error: 'Resource not found' })
    const ownerId = resourceType === 'order' ? resource.client_id : resource.id
    if (ownerId !== request.userId) return response.status(403).json({ error: 'Forbidden' })
    return next()
  }
}