import ClientRepository from "../repositories/ClientRepository.js";
import UserRepository from "../repositories/UserRepository.js";

class ClientService {
  async registerClient(clientData){
    const existsAdminUser = await UserRepository.findById(clientData.adminUserId)
    const existsClient = await ClientRepository.findByEmail(clientData.email)

    if(existsAdminUser) {
        throw new Error('Acesso negado, usuário administrador não cadastrado.')
    }

    if(existsClient){
        throw new Error('Usuário já existe');
    }

    try {
      const client = await ClientRepository.create(clientData);
      return client;
    } catch (error) {
      throw new Error(error)
    }
  }

  async updateClient(id, dataClient, idAdmin){
    const existsClients = await ClientRepository.findById(id)
    const existsUsersAdmin = await UserRepository.findById(idAdmin)

    if(!existsUsersAdmin) {
      throw new Error('Acesso negado');
    }

    if(!existsClients){
      throw new Error('Cliente não encontrado');
    }

    try {
        const fullUpdateClient = await ClientRepository.update(id, dataClient)
        return fullUpdateClient
      } catch (error) {
        throw new Error(error)
      
    }

  } 

  async facthUpdateClient(id, dataClient, idClient){
    const existsClients = await ClientRepository.findById(id)

    if(id !== idClient){
      throw new Error('Acesso negado');
    }

    if(!existsClients){
      throw new Error('Cliente não encontrado');
    }

    try {
        const facthUpdateClient = await ClientRepository.update(id, dataClient)
        return facthUpdateClient
      } catch (error) {
        throw new Error(error)
      
    }

  }

  async getAllClients(userId){
   const existsAdminUser = await UserRepository.findById(userId)

    if (!existsAdminUser || existsAdminUser.role !== 'admin') {
      throw new Error('Acesso negado');
    }

    try {
      const listClients = await ClientRepository.findAll()
      return listClients
    } catch (error) {
      throw new Error(error)
    }
  }


  async getDataClient(id){

    try {
      const client = await ClientRepository.findById(id);
        if (!client) {
          throw new Error('Cliente não encontrado');
        }
      return client
    } catch (error) {
      throw new Error(error)
    }
  }

  async deleteDataClient(id) {
    const searchClient = await ClientRepository.findById(id)

    if(!searchClient){
      throw new Error('Cliente não encontrado')
    }

    ClientRepository.delete(searchClient)
 }


  
}

export default new ClientService()