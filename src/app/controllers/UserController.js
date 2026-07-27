import { v4 } from 'uuid'
import validator from 'validator'
import UserService from '../services/UserService.js'
import * as Yup from 'yup'


// Função de sanitização reutilizável
const sanitizeInput = (data) => {
  const sanitizedData = {}
  Object.keys(data).forEach((key) => {
    sanitizedData[key] =
      typeof data[key] === 'string' ? validator.escape(data[key]) : data[key]
  })
  return sanitizedData
}

class UserController {
  async store (request, response) {
    const schema = Yup.object().shape({
      name: Yup.string().required(),
      email: Yup.string().email().required(),
      password: Yup.string().required().min(6),
      role: Yup.string().oneOf(['admin', 'user']).required(),
    })

    const sanitizedBody = sanitizeInput(request.body)

    try {
      await schema.validateSync(sanitizedBody, { abortEarly: false })
    } catch (err) {
      return response.status(400).json({ error: err.errors })
    }

    const { name, email, password, role } = sanitizedBody
    
    const userData = {
      name,
      email,
      password,
      role,
    }
      
    try {
      const user = await UserService.registerUser(userData)
      return response.status(201).json({ message: 'User created successfully', user: {
        id: user.id,
        name: user.name,
        email: user.email,
      } })

      } catch (err) {
        return response.status(400).json({ error: err, message: err.message })
    }
  }

  async index (request, response) {
    const { role } = request.user
    const listUsers = await UserService.listUsers(role)
    return response.json(listUsers)
  }

  async update (request, response) {
    const schema = Yup.object().shape({
      password: Yup.string().optional().min(6),
      name: Yup.string().optional(),
      email: Yup.string().email().optional(),
    })

    const sanitizedBody = sanitizeInput(request.body)

    try {
      await schema.validateSync(sanitizedBody, { abortEarly: false })
    } catch (err) {
      return response.status(400).json({ error: err.errors })
    }

    const { password, name, email } = sanitizedBody
    const id = request.userId 
    const userData = { password, name, email}


    try {
      await UserService.updateUser(id, userData)
      return response.status(200).json({message: 'Usuário atualizado com sucesso'})
    } catch (error) {
      return response.status(500).json({ error: err, message: err.message })
    }
   
  }
}

export default new UserController()
