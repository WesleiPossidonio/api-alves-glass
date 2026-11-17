import Sequelize, { Model } from 'sequelize';

class ServiceOrderProjectionCheckpoint extends Model {
  static init(sequelize) {
    super.init(
      {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        service_order_id: { type: Sequelize.UUID, allowNull: false },
        consumer_name: { type: Sequelize.STRING(80), allowNull: false },
        read_model_version: {
          type: Sequelize.BIGINT,
          allowNull: false,
          defaultValue: 0,
        },
        generation: { type: Sequelize.STRING(80), allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      },
      {
        sequelize,
        tableName: 'service_order_projection_checkpoints',
        timestamps: false,
        underscored: true,
      },
    );
    return this;
  }
}

export default ServiceOrderProjectionCheckpoint;
