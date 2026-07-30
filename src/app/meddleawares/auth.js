import Jwt from 'jsonwebtoken'
import authConfig from '../../config/auth.js'

export default (request, response, next) => {
  const token = request.cookies.token

  if (!token) {
    return response.status(401).json({ 
      error: 'Token not provided' 
    })
  }

  try {
    const decoded = Jwt.verify(token, authConfig.secret)

    request.userId = decoded.id
    request.userRole = decoded.role

    return next()

  } catch {
    return response.status(401).json({ 
      error: 'Token is invalid' 
    })
  }
}