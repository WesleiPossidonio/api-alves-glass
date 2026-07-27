import Sequelize, { Model } from 'sequelize'

class OrdersProducts extends Model {
  static init (sequelize) {
    super.init(
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
        },
        order_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        product_name: Sequelize.STRING,
        quantity: Sequelize.DECIMAL(10,2),
        unit_price: Sequelize.DECIMAL(10,2),
      },
      {
        sequelize,
        tableName: 'orders_products',
      }
    )

    return this
  }

  static associate (models) {
    this.belongsTo(models.Order, {
      foreignKey: 'order_id',
      as: 'order',
    })
  }
}

export default OrdersProducts
