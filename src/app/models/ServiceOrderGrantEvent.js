import Sequelize, { Model } from 'sequelize';

class ServiceOrderGrantEvent extends Model {
  static init(sequelize) {
    super.init(
      {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        grant_id: { type: Sequelize.UUID, allowNull: false },
        actor_user_id: { type: Sequelize.UUID, allowNull: false },
        target_user_id: { type: Sequelize.UUID, allowNull: false },
        sector_id: { type: Sequelize.UUID, allowNull: false },
        operation: { type: Sequelize.STRING(64), allowNull: false },
        action: { type: Sequelize.STRING(8), allowNull: false },
        reason: { type: Sequelize.STRING(500), allowNull: false },
        occurred_at: { type: Sequelize.DATE, allowNull: false },
        audit_hash: { type: Sequelize.STRING(64), allowNull: false },
        audit_previous_hash: { type: Sequelize.STRING(64), allowNull: false },
      },
      {
        sequelize,
        tableName: 'service_order_grant_events',
        timestamps: false,
        underscored: true,
      },
    );
    return this;
  }

  static associate(models) {
    this.belongsTo(models.ServiceOrderOperationGrant, {
      foreignKey: 'grant_id',
      as: 'grant',
    });
    this.belongsTo(models.User, { foreignKey: 'actor_user_id', as: 'actor' });
    this.belongsTo(models.User, { foreignKey: 'target_user_id', as: 'target' });
    this.belongsTo(models.Sector, { foreignKey: 'sector_id', as: 'sector' });
  }
}

export default ServiceOrderGrantEvent;
