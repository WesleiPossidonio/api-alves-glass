import Sequelize, { Model } from 'sequelize';

class ServiceOrderPermission extends Model {
  static init(sequelize) {
    super.init(
      {
        grant_id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        user_id: { type: Sequelize.UUID, allowNull: false },
        sector_id: { type: Sequelize.UUID, allowNull: false },
        operation: { type: Sequelize.STRING(64), allowNull: false },
      },
      {
        sequelize,
        tableName: 'service_order_permissions',
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
    this.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    this.belongsTo(models.Sector, { foreignKey: 'sector_id', as: 'sector' });
  }
}

export default ServiceOrderPermission;
