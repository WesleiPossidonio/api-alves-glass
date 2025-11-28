import Sequelize, { Model } from 'sequelize'
import bcrypt from 'bcrypt'

class Client extends Model {
  static init (sequelize) {
    super.init(
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
        },
        name: Sequelize.STRING,
        email: Sequelize.STRING,
        cpf_cnpj: Sequelize.STRING,
        cep: Sequelize.STRING,
        rua: Sequelize.STRING,
        number_house: Sequelize.STRING,
        bairro: Sequelize.STRING,
        cidade: Sequelize.STRING,
        uf: Sequelize.STRING,
        password: Sequelize.VIRTUAL,
        password_hash: Sequelize.STRING,
        number_client: Sequelize.STRING,
        update_number: Sequelize.STRING,
      },
      {
        sequelize,
        tableName: 'client',
        freezeTableName: true
      }
    )

    this.addHook('beforeSave', async (client) => {
      if (client.password) {
        client.password_hash = await bcrypt.hash(client.password, 10)
      }
    })

    return this
  }

  checkPassword (password) {
    return bcrypt.compare(password, this.password_hash)
  }

  static associate (models) {

    this.hasMany(models.Order, {
      foreignKey: 'client_id',
      as: 'orders',
    })
  }
}

export default Client
