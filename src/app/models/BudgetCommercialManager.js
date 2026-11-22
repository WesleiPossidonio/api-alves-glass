import Sequelize, { Model } from 'sequelize';

class BudgetCommercialManager extends Model {
  static init(sequelize) {
    super.init(
      {
        user_id: {
          type: Sequelize.UUID,
          primaryKey: true,
          allowNull: false,
          references: { model: 'users', key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'RESTRICT',
        },
        sector_id: {
          type: Sequelize.UUID,
          primaryKey: true,
          allowNull: false,
          references: { model: 'sectors', key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'RESTRICT',
        },
        appointed_by: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'RESTRICT',
        },
      },
      {
        sequelize,
        schema: 'public',
        tableName: 'budget_commercial_managers',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: false,
        underscored: true,
      },
    );
    return this;
  }
  static associate(models) {
    this.belongsTo(models.User, {
      foreignKey: 'user_id',
      as: 'user',
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    });
    this.belongsTo(models.Sector, {
      foreignKey: 'sector_id',
      as: 'sector',
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    });
    this.belongsTo(models.User, {
      foreignKey: 'appointed_by',
      as: 'appointedBy',
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    });
  }
}
export default BudgetCommercialManager;
