import Sequelize, { Model } from 'sequelize'

class InventoryOutbox extends Model {
  static init(sequelize) {
    super.init({
      event_id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      schema_version: { type: Sequelize.INTEGER, allowNull: false },
      aggregate_id: { type: Sequelize.UUID, allowNull: false },
      aggregate_version: { type: Sequelize.BIGINT, allowNull: false },
      event_type: { type: Sequelize.STRING(32), allowNull: false },
      payload: { type: Sequelize.JSONB, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'PENDING' },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      locked_until: { type: Sequelize.DATE, allowNull: true },
      locked_by: { type: Sequelize.UUID, allowNull: true },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      available_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    }, { sequelize, tableName: 'inventory_outbox', timestamps: false, underscored: true })
    return this
  }

  static associate(models) {
    this.belongsTo(models.InventoryEvent, { foreignKey: 'event_id', as: 'event' })
  }
}

export default InventoryOutbox