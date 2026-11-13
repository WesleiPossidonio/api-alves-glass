import Sequelize, { Model } from 'sequelize'

class Warehouse extends Model {
  static init(sequelize) {
    super.init({
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      sector_id: { type: Sequelize.UUID, allowNull: false },
      code: { type: Sequelize.STRING(64), allowNull: false },
      name: { type: Sequelize.STRING(160), allowNull: false },
      status: { type: Sequelize.ENUM('ACTIVE', 'INACTIVE'), allowNull: false, defaultValue: 'ACTIVE' },
    }, {
      sequelize,
      tableName: 'warehouses',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    })
    return this
  }

  static associate(models) {
    this.belongsTo(models.Sector, { foreignKey: 'sector_id', as: 'sector' })
  }
}

export default Warehouse