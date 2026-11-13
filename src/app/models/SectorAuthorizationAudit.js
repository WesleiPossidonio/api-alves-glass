import Sequelize, { Model } from 'sequelize'

class SectorAuthorizationAudit extends Model {
  static init(sequelize) {
    super.init({
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      actor_user_id: { type: Sequelize.UUID, allowNull: false },
      affected_user_id: { type: Sequelize.UUID, allowNull: false },
      sector_id: { type: Sequelize.UUID, allowNull: false },
      action: { type: Sequelize.ENUM('GRANT', 'REVOKE'), allowNull: false },
      reason: { type: Sequelize.STRING(500), allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
    }, {
      sequelize,
      tableName: 'sector_authorization_audits',
      timestamps: false,
      underscored: true,
    })
    return this
  }

  static associate(models) {
    this.belongsTo(models.User, { foreignKey: 'actor_user_id', as: 'actor' })
    this.belongsTo(models.User, { foreignKey: 'affected_user_id', as: 'affectedUser' })
    this.belongsTo(models.Sector, { foreignKey: 'sector_id', as: 'sector' })
  }
}

export default SectorAuthorizationAudit