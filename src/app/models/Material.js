import Sequelize, { Model } from 'sequelize'

class Material extends Model {
  static init(sequelize) {
    super.init({
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      warehouse_id: { type: Sequelize.UUID, allowNull: false },
      category_id: { type: Sequelize.UUID, allowNull: false },
      subcategory_id: { type: Sequelize.UUID, allowNull: true },
      code: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      name: { type: Sequelize.STRING(160), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      unit_code: { type: Sequelize.STRING(8), allowNull: false },
      min_quantity: { type: Sequelize.DECIMAL, allowNull: false, defaultValue: '0' },
      location: { type: Sequelize.STRING(160), allowNull: true },
      active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      qr_token_hash: { type: Sequelize.STRING(64), allowNull: true },
      qr_revoked_at: { type: Sequelize.DATE, allowNull: true },
      image_bucket: { type: Sequelize.STRING(255), allowNull: true },
      image_object_key: { type: Sequelize.TEXT, allowNull: true },
      image_visibility: { type: Sequelize.STRING(8), allowNull: true },
    }, { sequelize, tableName: 'materials', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at', underscored: true })
    return this
  }

  static associate(models) {
    this.belongsTo(models.MaterialCategory, { foreignKey: 'category_id', as: 'category' })
    this.belongsTo(models.MaterialSubcategory, { foreignKey: 'subcategory_id', as: 'subcategory' })
    this.belongsTo(models.Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse' })
    this.hasOne(models.MaterialBalance, { foreignKey: 'material_id', as: 'balance' })
  }
}

export default Material