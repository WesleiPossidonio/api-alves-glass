import Sequelize, { Model } from 'sequelize'

class ProductCategory extends Model {
  static init(sequelize) {
    super.init(
      {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
        name: { type: Sequelize.STRING, allowNull: false },
      },
      {
        sequelize,
        tableName: 'product_category',
      },
    )
    return this
  }

  static associate(models) {
    this.hasMany(models.Category, {
      foreignKey: 'category_section_id',
      as: 'categories',
    })
  }
}

export default ProductCategory
