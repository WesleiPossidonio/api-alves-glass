import Sequelize, { Model } from 'sequelize'
import { hashPassword, validatePassword } from '../services/passwordHashing.js'
import bcrypt from 'bcrypt'

class User extends Model {
  static init (sequelize) {
    super.init(
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
        },
        name: Sequelize.STRING,
        email: Sequelize.STRING,
        password: Sequelize.VIRTUAL,
        password_hash: Sequelize.STRING,
        status_users: {
          type: Sequelize.STRING,
          allowNull: false,
          defaultValue: 'active',
        },
        role: {
          type: Sequelize.ENUM('admin', 'user'),
          allowNull: false,
          defaultValue: 'user',
        },
        update_number: Sequelize.STRING,
        pin_hash: Sequelize.STRING(255),
        pin_lookup: Sequelize.STRING(64),
        pin_revoked_at: Sequelize.DATE,
      },
      {
        sequelize,
        tableName: 'users',
        freezeTableName: true
      }
    )

    this.addHook('beforeSave', async (user) => {
      if (user.password) {
        user.password_hash = await hashPassword(user.password)
      }
    })

    return this
  }

  checkPassword(password) {
    return validatePassword(password, this.password_hash, {
      legacyVerifier: (plain, hash) => bcrypt.compare(plain, hash),
    })
  }

  static associate(models) {
    this.hasMany(models.UserSector, { foreignKey: 'user_id', as: 'sectorGrants' })
    this.hasMany(models.UserSector, { foreignKey: 'granted_by', as: 'sectorGrantsCreated' })
    this.hasMany(models.SectorAuthorizationAudit, { foreignKey: 'actor_user_id', as: 'sectorAuthorizationActions' })
    this.hasMany(models.SectorAuthorizationAudit, { foreignKey: 'affected_user_id', as: 'sectorAuthorizationHistory' })
  }

}

export default User
