import { v4 } from 'uuid'
import validator from 'validator'
import * as Yup from 'yup'
import Client from '../models/Client.js'

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
      cpf_cnpj: Yup.string().required(),
      cep: Yup.string().required(),
      rua: Yup.string().required(),
      number_house: Yup.string().required(),
      bairro: Yup.string().required(),
      cidade: Yup.string().required(),
      uf: Yup.string().required(),
      password: Yup.string().min(6).optional(),
    })

    const sanitizedBody = sanitizeInput(request.body)

    try {
      await schema.validateSync(sanitizedBody, { abortEarly: false })
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
    } =
      sanitizedBody

    const emailNormalized = sanitizedBody.email.trim().toLowerCase()

    const emailClientExists = await Client.findOne({
      where: { email: emailNormalized },
    })

    const nameClientExists = await Client.findOne({
      where: { name },
    })

    if (emailClientExists) {
      return response.status(409).json({ error: 'Email user already exists' })
    }

    if (nameClientExists) {
      return response.status(409).json({ error: 'Name user already exists' })
    }

    const number_client = Math.floor(100000 + Math.random() * 900000).toString()
    const update_number = Math.floor(100000 + Math.random() * 900000).toString()

    await Client.create({
      id: v4(),
      name,
      email: emailNormalized,
      number_client: number_client,
      update_number: update_number,
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
    const listClient = await Client.findAll()
    return response.json(listClient)
  }

  async update (request, response) {
    const schema = Yup.object().shape({
      update_number: Yup.string().optional(),
      password: Yup.string().optional().min(6),
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
      await schema.validateSync(sanitizedBody, { abortEarly: false })
    } catch (err) {
      return response.status(400).json({ error: err.errors })
    }

    const { password, update_number, name, email } = sanitizedBody
    const { id } = request.params // Assumindo que `id` seja passado na URL (ex: /users/:id)

    if (update_number && !id) {
      const verificationNumber = await Client.findOne({
        where: { update_number },
      })

      if (!verificationNumber) {
        return response.status(400).json({ error: 'Invalid update number' })
      }

      const client = await Client.findOne({
        where: { update_number }
      })

      if (password) client.password = password
      await client.save();

      return response
        .status(200)
        .json({ message: 'Password updated successfully' })
    }

    const verificationClient = await Client.findOne({
      where: { id },
    })

    if (!verificationClient) {
      return response.status(404).json({ error: 'User not found' })
    }

    if (name) verificationClient.name = name
    if (email) verificationClient.email = email
    if (password) verificationClient.password = password

    await verificationClient.save();
    return response.status(200).json({ message: 'User updated successfully' })
  }
}

export default new UserController()
