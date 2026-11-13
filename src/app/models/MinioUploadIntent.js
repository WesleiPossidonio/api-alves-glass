import Sequelize, { Model } from 'sequelize'

class MinioUploadIntent extends Model {
  static init(sequelize) {
    super.init({
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      bucket: { type: Sequelize.STRING(255), allowNull: false },
      object_key: { type: Sequelize.TEXT, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'UPLOADING' },
      created_by: { type: Sequelize.UUID, allowNull: false },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      lease_expires_at: { type: Sequelize.DATE, allowNull: false },
      completed_at: { type: Sequelize.DATE, allowNull: true },
    }, {
      sequelize, tableName: 'minio_upload_intents', timestamps: true,
      createdAt: 'created_at', updatedAt: 'updated_at', underscored: true,
      indexes: [],
    })
    return this
  }

  static associate(models) {
    this.belongsTo(models.User, { foreignKey: 'created_by', as: 'creator' })
  }
}

export default MinioUploadIntent