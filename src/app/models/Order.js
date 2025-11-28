import Sequelize, { Model } from 'sequelize'

class Order extends Model {
  static init (sequelize) {
    super.init(
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
        },
        order_number: Sequelize.STRING,
        client_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        status_description: Sequelize.STRING,
        status: Sequelize.STRING,
        total: Sequelize.INTEGER,
      },
      {
        sequelize,
        tableName: 'order',
      }
    )
    return this
  }

  static associate (models) {
    this.hasMany(models.ServicesProducts, {
      foreignKey: 'service_id',
      as: 'products',
    })

    this.belongsTo(models.Client, {
      foreignKey: 'client_id',
      as: 'client', // CORRETO
    })
  }
}

export default Order
