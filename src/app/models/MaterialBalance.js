import Sequelize, { Model } from 'sequelize'

class MaterialBalance extends Model {
  static init(sequelize) {
    super.init({
      material_id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      quantity: { type: Sequelize.DECIMAL, allowNull: false, defaultValue: '0' },
    }, { sequelize, tableName: 'material_balances', timestamps: true, createdAt: false, updatedAt: 'updated_at', underscored: true })
    return this
  }

  static associate(models) {
    this.belongsTo(models.Material, { foreignKey: 'material_id', as: 'material' })
  }
}

export default MaterialBalance