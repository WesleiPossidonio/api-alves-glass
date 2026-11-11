import Sequelize, { Model } from 'sequelize'

class AuthSession extends Model {
  static init(sequelize) {
    super.init({
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      user_id: { type: Sequelize.UUID, allowNull: true },
      client_id: { type: Sequelize.UUID, allowNull: true },
      actor_type: { type: Sequelize.STRING(16), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
      revocation_reason: { type: Sequelize.STRING(32), allowNull: true },
      last_used_at: { type: Sequelize.DATE, allowNull: true },
    }, {
      sequelize,
      tableName: 'auth_sessions',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    })
    return this
  }

  static associate(models) {
    this.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' })
    this.belongsTo(models.Client, { foreignKey: 'client_id', as: 'client' })
    this.hasMany(models.AuthSessionRefreshToken, { foreignKey: 'session_id', as: 'refreshTokens' })
  }
}

export default AuthSession