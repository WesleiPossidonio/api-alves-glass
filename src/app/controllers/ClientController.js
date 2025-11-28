import { v4 } from 'uuid'
import validator from 'validator'
import * as Yup from 'yup'
import Client from '../models/Client.js'

// Sanitização sem quebrar CPF/CNPJ/CEP
const sanitizeInput = (data) => {
  const sanitized = {}

  for (const key of Object.keys(data)) {
    const value = data[key]

    if (typeof value === "string") {
      if (["cpf_cnpj", "cep"].includes(key)) {
        sanitized[key] = value.trim()
      } else {
        sanitized[key] = validator.escape(value.trim())
      }
    } else {
      sanitized[key] = value
    }
  }

  return sanitized
}

class UserController {
  async store (request, response) {
    const schema = Yup.object().shape({
      name: Yup.string().required(),
      email: Yup.string().email().required(),
      cpf_cnpj: Yup.string().required(),
      cep: Yup.string().required(),
      rua: Yup.string().required(),
      number_house: Yup.string().required(),
      bairro: Yup.string().required(),
      cidade: Yup.string().required(),
      uf: Yup.string().required(),
      password: Yup.string().min(6).required(),
    })

    const sanitizedBody = sanitizeInput(request.body)

    try {
      await schema.validate(sanitizedBody, { abortEarly: false })
    } catch (err) {
      return response.status(400).json({ error: err.errors })
    }

    const {
      name,
      cpf_cnpj,
      cep,
      rua,
      number_house,
      bairro,
      cidade,
      uf,
      password,
    } = sanitizedBody

    const email = sanitizedBody.email.toLowerCase()

    // Verifica duplicidade
    const emailClientExists = await Client.findOne({ where: { email } })
    if (emailClientExists) {
      return response.status(409).json({ error: 'Email already exists' })
    }

    const nameClientExists = await Client.findOne({ where: { name } })
    if (nameClientExists) {
      return response.status(409).json({ error: 'Name already exists' })
    }

    // números aleatórios
    const number_client = Math.floor(100000 + Math.random() * 900000).toString()
    const update_number = Math.floor(100000 + Math.random() * 900000).toString()

    await Client.create({
      id: v4(),
      name,
      email,
      number_client,
      update_number,
      cpf_cnpj,
      cep,
      rua,
      number_house,
      bairro,
      cidade,
      uf,
      password
    })

    return response.status(201).json({ message: 'User created successfully' })
  }

  async index (request, response) {
    const clients = await Client.findAll()
    return response.json(clients)
  }

  async update (request, response) {
    const schema = Yup.object().shape({
      update_number: Yup.string().optional(),
      password: Yup.string().min(6).optional(),
      name: Yup.string().optional(),
      email: Yup.string().email().optional(),
      cpf_cnpj: Yup.string().optional(),
      cep: Yup.string().optional(),
      rua: Yup.string().optional(),
      number_house: Yup.string().optional(),
      bairro: Yup.string().optional(),
      cidade: Yup.string().optional(),
      uf: Yup.string().optional(),
    })

    const sanitizedBody = sanitizeInput(request.body)

    try {
      await schema.validate(sanitizedBody, { abortEarly: false })
    } catch (err) {
      return response.status(400).json({ error: err.errors })
    }

    const { id } = request.params
    const { update_number, password, email, name } = sanitizedBody

    // 🔥 Atualização de senha via update_number
    if (update_number && !id) {
      const client = await Client.findOne({ where: { update_number } })

      if (!client) {
        return response.status(400).json({ error: 'Invalid update number' })
      }

      if (password) client.password = password

      await client.save()
      return response.status(200).json({ message: 'Password updated successfully' })
    }

    // 🔥 Atualização de perfil normal
    const client = await Client.findByPk(id)

    if (!client) {
      return response.status(404).json({ error: 'User not found' })
    }

    // previne email duplicado
    if (email) {
      const emailExists = await Client.findOne({
        where: { email, id: { $ne: id } },
      })

      if (emailExists) {
        return response.status(409).json({ error: 'Email already exists' })
      }

      client.email = email.toLowerCase()
    }

    if (name) client.name = name
    if (password) client.password = password

    await client.save()

    return response.status(200).json({ message: 'User updated successfully' })
  }
}

export default new UserController()
