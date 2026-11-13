import Sequelize, { Model } from 'sequelize'

class PinAttempt extends Model {
  static init(sequelize) {
    super.init({
      scope_hash: { type: Sequelize.STRING(64), primaryKey: true },
      window_started_at: { type: Sequelize.DATE, allowNull: false },
      failures: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      blocked_until: { type: Sequelize.DATE, allowNull: true },
    }, { sequelize, tableName: 'pin_attempts', timestamps: false, underscored: true })
    return this
  }
}

export default PinAttempt