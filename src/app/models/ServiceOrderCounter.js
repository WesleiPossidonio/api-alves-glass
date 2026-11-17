import Sequelize, { Model } from 'sequelize';

class ServiceOrderCounter extends Model {
  static init(sequelize) {
    super.init(
      {
        sector_id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        next_number: { type: Sequelize.BIGINT, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      },
      {
        sequelize,
        tableName: 'service_order_counters',
        timestamps: false,
        underscored: true,
      },
    );
    return this;
  }

  static associate(models) {
    this.belongsTo(models.Sector, { foreignKey: 'sector_id', as: 'sector' });
  }
}

export default ServiceOrderCounter;
