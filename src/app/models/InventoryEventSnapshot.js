import Sequelize, { Model } from 'sequelize'

class InventoryEventSnapshot extends Model {
  static init(sequelize) {
    super.init({
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      material_id: { type: Sequelize.UUID, allowNull: false },
      version: { type: Sequelize.BIGINT, allowNull: false },
      balance: { type: Sequelize.DECIMAL, allowNull: false },
      state: { type: Sequelize.JSONB, allowNull: false },
      checksum: { type: Sequelize.STRING(64), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    }, { sequelize, tableName: 'inventory_event_snapshots', timestamps: false, underscored: true })
    return this
  }
}

export default InventoryEventSnapshot