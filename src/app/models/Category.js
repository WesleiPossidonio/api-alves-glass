import Sequelize, { Model } from 'sequelize'

class Category extends Model {
  static init(sequelize) {
    super.init(
      {
        name: Sequelize.STRING,
        category_section_id: Sequelize.INTEGER,
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
