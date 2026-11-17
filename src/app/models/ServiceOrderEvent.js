import Sequelize, { Model } from 'sequelize';

class ServiceOrderEvent extends Model {
  static init(sequelize) {
    super.init(
      {
        event_id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        aggregate_id: { type: Sequelize.UUID, allowNull: false },
        aggregate_version: { type: Sequelize.BIGINT, allowNull: false },
        schema_version: { type: Sequelize.INTEGER, allowNull: false },
        event_type: { type: Sequelize.STRING(80), allowNull: false },
        actor_user_id: { type: Sequelize.UUID, allowNull: true },
        sector_id: { type: Sequelize.UUID, allowNull: false },
        product_item_id: { type: Sequelize.UUID, allowNull: true },
        revision: { type: Sequelize.INTEGER, allowNull: true },
        cycle: { type: Sequelize.INTEGER, allowNull: true },
        correlation_id: { type: Sequelize.UUID, allowNull: true },
        payload: { type: Sequelize.JSONB, allowNull: false },
        occurred_at: { type: Sequelize.DATE, allowNull: false },
      },
      {
        sequelize,
        tableName: 'service_order_events',
        timestamps: false,
        underscored: true,
      },
    );
    return this;
  }

  static associate(models) {
    this.belongsTo(models.ServiceOrder, {
      foreignKey: 'aggregate_id',
      as: 'aggregate',
    });
    this.belongsTo(models.ServiceOrderProduct, {
      foreignKey: 'product_item_id',
      as: 'product',
    });
    this.belongsTo(models.User, { foreignKey: 'actor_user_id', as: 'actor' });
    this.belongsTo(models.Sector, { foreignKey: 'sector_id', as: 'sector' });
    this.hasOne(models.ServiceOrderOutbox, {
      foreignKey: 'event_id',
      as: 'outbox',
    });
  }
}

export default ServiceOrderEvent;
