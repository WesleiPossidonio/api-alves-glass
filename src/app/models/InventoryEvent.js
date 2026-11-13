import Sequelize, { Model } from 'sequelize'

class InventoryEvent extends Model {
  static init(sequelize) {
    super.init({
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      material_id: { type: Sequelize.UUID, allowNull: false },
      warehouse_id: { type: Sequelize.UUID, allowNull: false },
      event_type: { type: Sequelize.STRING(16), allowNull: false },
      delta: { type: Sequelize.DECIMAL, allowNull: false },
      balance_before: { type: Sequelize.DECIMAL, allowNull: false },
      balance_after: { type: Sequelize.DECIMAL, allowNull: false },
      unit_code_snapshot: { type: Sequelize.STRING(8), allowNull: false },
      reason_code: { type: Sequelize.STRING(32), allowNull: true },
      description: { type: Sequelize.STRING(1000), allowNull: false },
      sequence: { type: Sequelize.BIGINT, allowNull: false },
      performed_by: { type: Sequelize.UUID, allowNull: true },
      received_by: { type: Sequelize.UUID, allowNull: true },
      withdrawn_by: { type: Sequelize.UUID, allowNull: true },
      authorized_by: { type: Sequelize.UUID, allowNull: true },
      command_origin: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'SESSION' },
      occurred_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      return_of_event_id: { type: Sequelize.UUID, allowNull: true },
      compensates_event_id: { type: Sequelize.UUID, allowNull: true },
    }, { sequelize, tableName: 'inventory_events', timestamps: false, underscored: true })
    return this
  }

  static associate(models) {
    this.belongsTo(models.Material, { foreignKey: 'material_id', as: 'material' })
    this.belongsTo(models.Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse' })
    this.belongsTo(models.User, { foreignKey: 'performed_by', as: 'performedBy' })
    this.belongsTo(models.User, { foreignKey: 'received_by', as: 'receivedBy' })
    this.belongsTo(models.User, { foreignKey: 'withdrawn_by', as: 'withdrawnBy' })
    this.belongsTo(models.User, { foreignKey: 'authorized_by', as: 'authorizedBy' })
    this.belongsTo(models.InventoryEvent, { foreignKey: 'return_of_event_id', as: 'returnOf' })
    this.belongsTo(models.InventoryEvent, { foreignKey: 'compensates_event_id', as: 'compensates' })
  }
}

export default InventoryEvent