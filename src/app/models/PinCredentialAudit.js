import Sequelize, { Model } from 'sequelize'

class PinCredentialAudit extends Model {
  static init(sequelize) {
    super.init({
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      user_id: { type: Sequelize.UUID, allowNull: false },
      actor_user_id: { type: Sequelize.UUID, allowNull: false },
      action: { type: Sequelize.STRING(16), allowNull: false },
      reason: { type: Sequelize.STRING(500), allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    }, { sequelize, tableName: 'pin_credential_audits', timestamps: false, underscored: true })
    return this
  }

  static associate(models) {
    this.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' })
    this.belongsTo(models.User, { foreignKey: 'actor_user_id', as: 'actor' })
  }
}

export default PinCredentialAudit