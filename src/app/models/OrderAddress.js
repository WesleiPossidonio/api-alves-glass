import Sequelize, { Model } from 'sequelize'

class OrderAddress extends Model {
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
          references: {
            model: 'order',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL'
        },
        cep: Sequelize.STRING,
        rua: Sequelize.STRING,
        number_house: Sequelize.STRING,
        bairro: Sequelize.STRING,
        cidade: Sequelize.STRING,
        uf: Sequelize.STRING
      },
      {
        sequelize,
        tableName: 'order_address',
        freezeTableName: true
      }
    )

    return this
  }

  static associate (models) {

    this.belongsTo(models.Order, {
      foreignKey: 'order_id',
      as: 'order_address',
    })
  }
}

export default OrderAddress