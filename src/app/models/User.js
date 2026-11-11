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

}

export default User
