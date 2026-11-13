import Sequelize, { Model } from 'sequelize'

class Sector extends Model {
  static init(sequelize) {
    super.init({
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      code: { type: Sequelize.STRING(32), allowNull: false, unique: true },
      name: { type: Sequelize.STRING(120), allowNull: false },
    }, {
      sequelize,
      tableName: 'sectors',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    })
    return this
  }

  static associate(models) {
    this.hasMany(models.Warehouse, { foreignKey: 'sector_id', as: 'warehouses' })
    this.hasMany(models.UserSector, { foreignKey: 'sector_id', as: 'userGrants' })
  }
}

export default Sector