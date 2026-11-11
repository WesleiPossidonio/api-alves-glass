export function authorize({ actorTypes = ['user', 'client'], roles } = {}) {
  return (request, response, next) => {
    if (!request.actorType || !actorTypes.includes(request.actorType)) {
      return response.status(403).json({ error: 'Forbidden' })
    }
    if (request.actorType === 'user' && roles && !roles.includes(request.userRole)) {
      return response.status(403).json({ error: 'Forbidden' })
    }
    return next()
  }
}

export const requireUser = authorize({ actorTypes: ['user'] })
export const requireAdmin = authorize({ actorTypes: ['user'], roles: ['admin'] })
export const requireClient = authorize({ actorTypes: ['client'] })