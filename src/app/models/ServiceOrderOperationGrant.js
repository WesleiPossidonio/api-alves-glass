import Sequelize, { Model } from 'sequelize';

class ServiceOrderOperationGrant extends Model {
  static init(sequelize) {
    super.init(
      {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        user_id: { type: Sequelize.UUID, allowNull: false },
        sector_id: { type: Sequelize.UUID, allowNull: false },
        operation: { type: Sequelize.STRING(64), allowNull: false },
        granted_by: { type: Sequelize.UUID, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false },
        reason: { type: Sequelize.STRING(500), allowNull: false },
      },
      {
        sequelize,
        tableName: 'service_order_operation_grants',
        timestamps: false,
        underscored: true,
      },
    );
    return this;
  }

  static associate(models) {
    this.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    this.belongsTo(models.Sector, { foreignKey: 'sector_id', as: 'sector' });
    this.belongsTo(models.User, { foreignKey: 'granted_by', as: 'grantedBy' });
  }
}

export default ServiceOrderOperationGrant;
