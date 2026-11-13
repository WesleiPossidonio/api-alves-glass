import Sequelize, { Model } from 'sequelize'

class QrPublicRateLimit extends Model {
  static init(sequelize) {
    super.init({
      origin_hash: { type: Sequelize.STRING(64), primaryKey: true },
      window_started_at: { type: Sequelize.DATE, allowNull: false },
      request_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      expires_at: { type: Sequelize.DATE, allowNull: false },
    }, {
      sequelize, tableName: 'qr_public_rate_limits', timestamps: false, underscored: true,
      indexes: [{ fields: ['expires_at'], name: 'qr_public_rate_limits_expires_at_idx' }],
    })
    return this
  }
}

export default QrPublicRateLimit