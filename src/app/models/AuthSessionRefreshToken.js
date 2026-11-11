import Sequelize, { Model } from 'sequelize'

class AuthSessionRefreshToken extends Model {
  static init(sequelize) {
    super.init({
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      session_id: { type: Sequelize.UUID, allowNull: false },
      token_hash: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      consumed_at: { type: Sequelize.DATE, allowNull: true },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
    }, {
      sequelize,
      tableName: 'auth_session_refresh_tokens',
      timestamps: false,
      underscored: true,
    })
    return this
  }

  static associate(models) {
    this.belongsTo(models.AuthSession, { foreignKey: 'session_id', as: 'session' })
  }
}

export default AuthSessionRefreshToken