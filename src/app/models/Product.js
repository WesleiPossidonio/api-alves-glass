import Sequelize, { Model } from 'sequelize'

class Product extends Model {
  static init(sequelize) {
    super.init(
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          allowNull: false,
          primaryKey: true,
        },
        category_id: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },
        control_level: Sequelize.ENUM('FREE', 'RESTRICTED'),
        item_name: Sequelize.STRING,
        unit: Sequelize.STRING,
        sector_name: Sequelize.STRING,
        code: Sequelize.STRING,
        quantity: Sequelize.INTEGER,
        min_quantity: Sequelize.INTEGER,
        location: Sequelize.STRING,
      },
      {
        sequelize,
        tableName: 'Product',
        freezeTableName: true,
      },
    )
    return this
  }

  static associate(models) {
    this.belongsTo(models.Category, {
      foreignKey: 'category_id',
      as: 'category',
    })
  }
}

export default Product
