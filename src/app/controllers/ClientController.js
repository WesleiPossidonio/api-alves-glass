import { v4 } from 'uuid'
import validator from 'validator'
import * as Yup from 'yup'
import ClientService from '../services/ClientService.js'

const sanitizeInput = (data) => {
  const sanitized = {}

  for (const key of Object.keys(data)) {
    const value = data[key]

    if (typeof value === "string") {
      if (["phone", "cep"].includes(key)) {
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

class ClientController {
  async store (request, response) {
    const schema = Yup.object().shape({
      name: Yup.string().required(),
      email: Yup.string().email().required(),
      phone: Yup.string().required(),
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
      phone,
      cep,
      rua,
      number_house,
      bairro,
      cidade,
      uf,
      password,
    } = sanitizedBody

    const email = sanitizedBody.email.toLowerCase()

    const update_number = Math.floor(100000 + Math.random() * 900000).toString()

    const dataClient = {
      id: v4(),
      name,
      email,
      update_number,
      phone,
      cep,
      rua,
      number_house,
      bairro,
      cidade,
      uf,
      password
    }

    try{
      const createdClient =
      await ClientService.registerClient(dataClient)
      return response.status(200).json({ message: 'Cliente cadastrado com sucesso.'})
    }catch (err) {
       return response.status(400).json({ error: err.message })
    }

  }

  async index (request, response) {
    const id = request.userId

    try {
      const listClients = await ClientService.getAllClients(id)
      return response.status(200).json(listClients)
    }catch (err) {
       return response.status(400).json({error: err.message})
    }
  }

  async getclientData( request, response){
    const id = request.userId

    try {
      const listClients = await ClientService.getDataClient(id)
      return response.status(200).json(listClients)
    }catch (err) {
       return response.status(400).json({error: err.message})
    }
  }

  async update (request, response) {
    const schema = Yup.object().shape({
      update_number: Yup.string().optional(),
      password: Yup.string().min(6).optional(),
      name: Yup.string().optional(),
      email: Yup.string().email().optional(),
      phone: Yup.string().optional(),
      cep: Yup.string().optional(),
      rua: Yup.string().optional(),
      number_house: Yup.string().optional(),
      bairro: Yup.string().optional(),
      cidade: Yup.string().optional(),
      uf: Yup.string().optional(),
      status: Yup.string().enums(['active', 'inactive']).optional(),
    })

    const sanitizedBody = sanitizeInput(request.body)

    try {
      await schema.validate(sanitizedBody, { abortEarly: false })
    } catch (err) {
      return response.status(400).json({ error: err.errors })
    }

    const { id } = request.params
    const authenticatedUserId = request.userId



    const {
      update_number,
      password,
      email,
      name,
      phone,
      cep,
      rua,
      number_house,
      bairro,
      cidade,
      uf,
      status
    } = sanitizedBody

    const dataClient = {
      id,
      update_number,
      password,
      email,
      name,
      phone,
      cep,
      rua,
      number_house,
      bairro,
      cidade,
      uf,
      status,
      idAdmin: authenticatedUserId
    }

    try {
      await ClientService.updateClient(dataClient)
      return response.status(200).json({message: 'Dados atualizados com sucesso.'})

    } catch (err) {
      return response.status(400).json({error: err.message})
    }
  }

  async patch (request, response) {
    const schema = Yup.object().shape({
      update_number: Yup.string().optional(),
      password: Yup.string().min(6).optional(),
      name: Yup.string().optional(),
      email: Yup.string().email().optional(),
      phone: Yup.string().optional(),
      cep: Yup.string().optional(),
      rua: Yup.string().optional(),
      number_house: Yup.string().optional(),
      bairro: Yup.string().optional(),
      cidade: Yup.string().optional(),
      uf: Yup.string().optional(),
      status: Yup.string().enums(['active', 'inactive']).optional(),
    })

    const sanitizedBody = sanitizeInput(request.body)

    try {
      await schema.validate(sanitizedBody, { abortEarly: false })
    } catch (err) {
      return response.status(400).json({ error: err.errors })
    }

    const { id } = request.params
    const idClient = request.userId


    const {
      update_number,
      password,
      email,
      name,
      phone,
      cep,
      rua,
      number_house,
      bairro,
      cidade,
      uf,
      status
    } = sanitizedBody

    const dataClient = {
      id,
      update_number,
      password,
      email,
      name,
      phone,
      cep,
      rua,
      number_house,
      bairro,
      cidade,
      uf,
      status,
      idClient
    }

    try {
      await ClientService.facthUpdateClient(dataClient)
      return response.status(200).json({message: 'Dados atualizados com sucesso.'})

    } catch (err) {
      return response.status(400).json({error: err.message})
    }
  }
}

export default new ClientController()
