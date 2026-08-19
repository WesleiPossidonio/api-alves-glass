import { Sequelize } from 'sequelize';
import Budget from '../models/Budget.js';
import Client from '../models/Client.js';

class ClientRepository {
  async findByEmail (email) {
    return await Client.findOne({ where: { email } });
  }

  async findById (id) {
    return await Client.findByPk(id);
  }

  async findAll (filters) {
    const {
      page = 1,
      limit = 10,
    } = filters;

    const offset = (page - 1) * limit;
    const { rows, count } = await Client.findAndCountAll({
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
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    return {
      clients: rows,
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit),
      },
    };
  }

  async findAllWithSearch (filters) {
    const {
      search,
      page = 1,
      limit = 10,
    } = filters;

    const offset = (page - 1) * limit;
    const clients = await sequelize.query(
      `
    SELECT
      clients.*,
      COUNT(*) OVER() AS total
    FROM clients
    WHERE
      to_tsvector(
        'portuguese',
        coalesce(name,'') || ' ' ||
        coalesce(email,'') || ' ' ||
        coalesce(cpf_cnpj,'')
      )
      @@ plainto_tsquery('portuguese', :search)

    ORDER BY "createdAt" DESC

    LIMIT :limit
    OFFSET :offset
    `,
      {
        replacements: {
          search,
          limit,
          offset,
        },
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    const total = clients.length ? Number(clients[0].total) : 0;
    return {
      clients: clients.map(({ total, ...client }) => client),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
  async create (clientData) {
    return await Client.create(clientData);
  }

  async update (id, clientData) {
    const client = await this.findById(id);
    if (!client) {
      throw new Error('Client not found');
    }
    return await client.update(clientData);
  }

  async delete (client) {
    return await client.destroy();
  }
}

export default new ClientRepository()
