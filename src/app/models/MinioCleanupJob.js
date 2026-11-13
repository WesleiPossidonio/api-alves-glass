import Sequelize, { Model } from 'sequelize'

class MinioCleanupJob extends Model {
  static init(sequelize) {
    super.init({
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      bucket: { type: Sequelize.STRING(255), allowNull: false },
      object_key: { type: Sequelize.TEXT, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'PENDING' },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      next_attempt_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      locked_at: { type: Sequelize.DATE, allowNull: true },
      locked_by: { type: Sequelize.STRING(128), allowNull: true },
      processed_at: { type: Sequelize.DATE, allowNull: true },
    }, {
      sequelize, tableName: 'minio_cleanup_jobs', timestamps: true,
      createdAt: 'created_at', updatedAt: 'updated_at', underscored: true,
      indexes: [],
    })
    return this
  }

}

export default MinioCleanupJob