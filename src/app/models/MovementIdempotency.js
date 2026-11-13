import Sequelize, { Model } from 'sequelize'

class MovementIdempotency extends Model {
  static init(sequelize) {
    super.init({
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      warehouse_id: { type: Sequelize.UUID, allowNull: false },
      operation_id: { type: Sequelize.UUID, allowNull: false },
      principal_type: { type: Sequelize.STRING(16), allowNull: false },
      principal_id: { type: Sequelize.UUID, allowNull: false },
      idempotency_key: { type: Sequelize.STRING(200), allowNull: false },
      request_hash: { type: Sequelize.STRING(64), allowNull: false },
      event_id: { type: Sequelize.UUID, allowNull: true },
      response_status: { type: Sequelize.INTEGER, allowNull: true },
      response_body: { type: Sequelize.JSONB, allowNull: true },
    }, { sequelize, tableName: 'movement_idempotency', timestamps: true, createdAt: 'created_at', updatedAt: false, underscored: true })
    return this
  }

  static associate(models) {
    this.belongsTo(models.Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse' })
    this.belongsTo(models.InventoryEvent, { foreignKey: 'event_id', as: 'event' })
  }
}

export default MovementIdempotency