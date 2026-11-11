import Sequelize, { Model } from 'sequelize'

class Category extends Model {
  static init(sequelize) {
    super.init(
      {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
        name: { type: Sequelize.STRING, allowNull: false },
        category_section_id: { type: Sequelize.INTEGER, allowNull: false },
      },
      {
        sequelize,
        tableName: 'category',
      },
    )
    return this
  }

  static associate(models) {
    this.hasMany(models.Product, {
      foreignKey: 'category_id',
      as: 'items',
    })

    this.belongsTo(models.ProductCategory, {
      foreignKey: 'category_section_id',
      as: 'section',
    })
  }
}

export default Category
