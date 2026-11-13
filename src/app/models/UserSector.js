import Sequelize, { Model } from 'sequelize'

class UserSector extends Model {
  static init(sequelize) {
    super.init({
      user_id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      sector_id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      granted_by: { type: Sequelize.UUID, allowNull: false },
    }, {
      sequelize,
      tableName: 'user_sectors',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      underscored: true,
    })
    return this
  }

  static associate(models) {
    this.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' })
    this.belongsTo(models.Sector, { foreignKey: 'sector_id', as: 'sector' })
    this.belongsTo(models.User, { foreignKey: 'granted_by', as: 'grantedBy' })
  }
}

export default UserSector