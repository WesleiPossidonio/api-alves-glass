import Sequelize, { Model } from 'sequelize'

class ProductCategory extends Model {
  static init(sequelize) {
    super.init(
      {
        name: Sequelize.STRING,
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
