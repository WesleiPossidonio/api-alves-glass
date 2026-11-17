import Sequelize, { Model } from 'sequelize';

class ServiceOrderCycle extends Model {
  static init(sequelize) {
    super.init(
      {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        service_order_id: { type: Sequelize.UUID, allowNull: false },
        cycle_number: { type: Sequelize.INTEGER, allowNull: false },
        reason: { type: Sequelize.STRING(1000), allowNull: false },
        reopened_by: { type: Sequelize.UUID, allowNull: false },
        scope: { type: Sequelize.JSONB, allowNull: false },
        active: { type: Sequelize.BOOLEAN, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false },
        closed_at: { type: Sequelize.DATE, allowNull: true },
      },
      {
        sequelize,
        tableName: 'service_order_cycles',
        timestamps: false,
        underscored: true,
      },
    );
    return this;
  }

  static associate(models) {
    this.belongsTo(models.ServiceOrder, {
      foreignKey: 'service_order_id',
      as: 'serviceOrder',
    });
    this.belongsTo(models.User, {
      foreignKey: 'reopened_by',
      as: 'reopenedBy',
    });
  }
}

export default ServiceOrderCycle;
