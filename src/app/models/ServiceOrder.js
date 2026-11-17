import Sequelize, { Model } from 'sequelize';

class ServiceOrder extends Model {
  static init(sequelize) {
    super.init(
      {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        external_number: { type: Sequelize.STRING(64), allowNull: false },
        client_id: { type: Sequelize.UUID, allowNull: false },
        sector_id: { type: Sequelize.UUID, allowNull: false },
        due_at: { type: Sequelize.DATE, allowNull: false },
        notes: { type: Sequelize.STRING(4000), allowNull: true },
        public_status: { type: Sequelize.STRING(32), allowNull: false },
        functional_status: { type: Sequelize.STRING(32), allowNull: true },
        administrative_state: { type: Sequelize.STRING(16), allowNull: false },
        operational_version: { type: Sequelize.BIGINT, allowNull: false },
        queue_entered_at: { type: Sequelize.DATE, allowNull: false },
        production_completed: { type: Sequelize.BOOLEAN, allowNull: false },
        is_priority: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        priority_changed_by: { type: Sequelize.UUID, allowNull: true },
        priority_changed_at: { type: Sequelize.DATE, allowNull: true },
        created_by: { type: Sequelize.UUID, allowNull: false },
      },
      { sequelize, tableName: 'service_orders', underscored: true },
    );
    return this;
  }

  static associate(models) {
    this.belongsTo(models.Client, { foreignKey: 'client_id', as: 'client' });
    this.belongsTo(models.Sector, { foreignKey: 'sector_id', as: 'sector' });
    this.belongsTo(models.User, { foreignKey: 'created_by', as: 'creator' });
    this.hasMany(models.ServiceOrderProduct, {
      foreignKey: 'service_order_id',
      as: 'products',
    });
    this.hasMany(models.ServiceOrderEvent, {
      foreignKey: 'aggregate_id',
      as: 'events',
    });
    this.hasMany(models.ServiceOrderAssignment, {
      foreignKey: 'service_order_id',
      as: 'assignments',
    });
    this.hasMany(models.ServiceOrderResponsibility, {
      foreignKey: 'service_order_id',
      as: 'responsibilityHistory',
    });
    this.hasMany(models.ServiceOrderQuality, {
      foreignKey: 'service_order_id',
      as: 'qualityActions',
    });
    this.hasMany(models.ServiceOrderCycle, {
      foreignKey: 'service_order_id',
      as: 'cycles',
    });
  }
}

export default ServiceOrder;
