import Sequelize, { Model } from 'sequelize'

class ServicesProducts extends Model {
  static init (sequelize) {
    super.init(
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
        },
        order_id: Sequelize.UUID,
        product_name: Sequelize.STRING,
        quantity: Sequelize.STRING,
        price: Sequelize.STRING,
      },
      {
        sequelize,
        tableName: 'services_products',
      },
    )

    return this
  }

  static associate (models) {
    this.belongsTo(models.Order, {
      foreignKey: 'order_id',
      as: 'order',  // 🔥 Correto
    })
  }
}

export default ServicesProducts
