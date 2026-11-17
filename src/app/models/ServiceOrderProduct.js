import Sequelize, { Model } from 'sequelize';

class ServiceOrderProduct extends Model {
  static init(sequelize) {
    super.init(
      {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        service_order_id: { type: Sequelize.UUID, allowNull: false },
        name: { type: Sequelize.STRING(240), allowNull: false },
        description: { type: Sequelize.STRING(2000), allowNull: true },
        quantity: { type: Sequelize.INTEGER, allowNull: false },
        unit_code: { type: Sequelize.STRING(2), allowNull: false },
        measurements: { type: Sequelize.JSONB, allowNull: false },
        specification_revision: { type: Sequelize.INTEGER, allowNull: false },
        completed_quantity: { type: Sequelize.INTEGER, allowNull: false },
        blocked_quantity: { type: Sequelize.INTEGER, allowNull: false },
      },
      { sequelize, tableName: 'service_order_products', underscored: true },
    );
    return this;
  }

  static associate(models) {
    this.belongsTo(models.ServiceOrder, {
      foreignKey: 'service_order_id',
      as: 'serviceOrder',
    });
    this.hasMany(models.ServiceOrderEvent, {
      foreignKey: 'product_item_id',
      as: 'events',
    });
    this.hasMany(models.ServiceOrderAssignment, {
      foreignKey: 'product_id',
      as: 'assignments',
    });
    this.hasMany(models.ServiceOrderQuality, {
      foreignKey: 'product_id',
      as: 'qualityActions',
    });
  }
}

export default ServiceOrderProduct;
