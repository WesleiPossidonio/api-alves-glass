import Sequelize, { Model } from 'sequelize';

class ServiceOrderResponsibility extends Model {
  static init(sequelize) {
    super.init(
      {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        service_order_id: { type: Sequelize.UUID, allowNull: false },
        user_id: { type: Sequelize.UUID, allowNull: false },
        assigned_by: { type: Sequelize.UUID, allowNull: false },
        released_by: { type: Sequelize.UUID, allowNull: true },
        assigned_at: { type: Sequelize.DATE, allowNull: false },
        released_at: { type: Sequelize.DATE, allowNull: true },
        release_reason: { type: Sequelize.STRING(1000), allowNull: true },
      },
      {
        sequelize,
        tableName: 'service_order_responsibilities',
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
    this.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    this.belongsTo(models.User, {
      foreignKey: 'assigned_by',
      as: 'assignedBy',
    });
    this.belongsTo(models.User, {
      foreignKey: 'released_by',
      as: 'releasedBy',
    });
  }
}

export default ServiceOrderResponsibility;
