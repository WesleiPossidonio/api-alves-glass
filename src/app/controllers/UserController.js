import { v4 } from 'uuid'
import validator from 'validator'

import * as Yup from 'yup'
import User from '../models/User'

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
      admin: Yup.boolean().required(),
      update_number: Yup.string().optional(),
    })

    const sanitizedBody = sanitizeInput(request.body)

    try {
      await schema.validateSync(sanitizedBody, { abortEarly: false })
    } catch (err) {
      return response.status(400).json({ error: err.errors })
    }

    const { name, email, password, admin, update_number } =
      sanitizedBody

    const emailUserExists = await User.findOne({
      where: { email },
    })

    const nameUserExists = await User.findOne({
      where: { name },
    })

    if (emailUserExists) {
      return response.status(409).json({ error: 'Email user already exists' })
    }

    if (nameUserExists) {
      return response.status(409).json({ error: 'Name user already exists' })
    }

    await User.create({
      id: v4(),
      name,
      email,
      password,
      admin,
      update_number,
    })

    return response.status(201).json({ message: 'User created successfully' })
  }

  async index (request, response) {
    const listExercices = await User.findAll()
    return response.json(listExercices)
  }

  async update (request, response) {
    const schema = Yup.object().shape({
      update_number: Yup.string().optional(),
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

    const { password, update_number, name, email } = sanitizedBody
    const { id } = request.params // Assumindo que `id` seja passado na URL (ex: /users/:id)

    if (update_number && !id) {
      const verificationNumber = await User.findOne({
        where: { update_number },
      })

      if (!verificationNumber) {
        return response.status(400).json({ error: 'Invalid update number' })
      }

      const user = await User.findOne({
        where: { update_number }
      })

      if (password) user.password = password
      await user.save();

      return response
        .status(200)
        .json({ message: 'Password updated successfully' })
    }

    const verificationUser = await User.findOne({
      where: { id },
    })

    if (!verificationUser) {
      return response.status(404).json({ error: 'User not found' })
    }

    if (name) verificationUser.name = name
    if (email) verificationUser.email = email
    if (password) verificationUser.password = password

    await verificationUser.save();
    return response.status(200).json({ message: 'User updated successfully' })
  }
}

export default new UserController()
