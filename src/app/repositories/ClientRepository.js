import Budget from '../models/Budget.js';
import Client from '../models/Client.js';

class ClientRepository {
 async findByEmail(email) {
   return await Client.findOne({ where: { email } });
 }

 async findById(id) {
   return await Client.findByPk(id);
 }

 async findAll () {
  return await Client.findAll({
    attributes: [
    "id",
    "name",
    "email",
    "client_status",
		"cep",
		"rua",
		"number_house",
		"bairro",
		"cidade",
		"uf",
    "createdAt",
    "updatedAt"
  ],
    order: [["createdAt", "ASC"]],
    include: [{ model: Budget, as: "budgets" }],
  });
 }

 async create(clientData) {
   return await Client.create(clientData);
 }

 async update(id, clientData) {
   const client = await this.findById(id);
   if (!client) {
     throw new Error('Client not found');
   }
   return await client.update(clientData);
 }

 async delete(client) {
   return await client.destroy();
 }
}

export default new ClientRepository()
