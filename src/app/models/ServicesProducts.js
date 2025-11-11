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
        service_id: Sequelize.STRING,
        product_name: Sequelize.STRING,
        quantity: Sequelize.STRING,
        price: Sequelize.STRING,
      },
      {
        sequelize,
      },
    )

    return this
  }

  static associate (models) {
    this.belongsTo(models.Order, {
      foreignKey: 'service_id',
      as: 'products',
    })
  }
}

export default ServicesProducts
