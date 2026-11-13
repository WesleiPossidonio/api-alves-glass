import Sequelize, { Model } from 'sequelize'

class MaterialCategory extends Model {
  static init(sequelize) {
    super.init({
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      warehouse_id: { type: Sequelize.UUID, allowNull: false },
      name: { type: Sequelize.STRING(120), allowNull: false },
      active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
    }, { sequelize, tableName: 'material_categories', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true })
    return this
  }

  static associate(models) {
    this.belongsTo(models.Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse' })
    this.hasMany(models.MaterialSubcategory, { foreignKey: 'category_id', as: 'subcategories' })
    this.hasMany(models.Material, { foreignKey: 'category_id', as: 'materials' })
  }
}

export default MaterialCategory