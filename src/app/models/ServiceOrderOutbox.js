import Sequelize, { Model } from 'sequelize';

class ServiceOrderOutbox extends Model {
  static init(sequelize) {
    super.init(
      {
        event_id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        aggregate_id: { type: Sequelize.UUID, allowNull: false },
        aggregate_version: { type: Sequelize.BIGINT, allowNull: false },
        schema_version: { type: Sequelize.INTEGER, allowNull: false },
        event_type: { type: Sequelize.STRING(80), allowNull: false },
        payload: { type: Sequelize.JSONB, allowNull: false },
        status: { type: Sequelize.STRING(16), allowNull: false },
        attempts: { type: Sequelize.INTEGER, allowNull: false },
        available_at: { type: Sequelize.DATE, allowNull: false },
        locked_until: { type: Sequelize.DATE, allowNull: true },
        locked_by: { type: Sequelize.UUID, allowNull: true },
        last_error: { type: Sequelize.TEXT, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false },
      },
      {
        sequelize,
        tableName: 'service_order_outbox',
        timestamps: false,
        underscored: true,
      },
    );
    return this;
  }

  static associate(models) {
    this.belongsTo(models.ServiceOrderEvent, {
      foreignKey: 'event_id',
      as: 'event',
    });
  }
}

export default ServiceOrderOutbox;
