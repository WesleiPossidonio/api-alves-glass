import Sequelize, { Model } from 'sequelize';

class ServiceOrderQuality extends Model {
  static init(sequelize) {
    super.init(
      {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        service_order_id: { type: Sequelize.UUID, allowNull: false },
        product_id: { type: Sequelize.UUID, allowNull: false },
        parent_quality_id: { type: Sequelize.UUID, allowNull: true },
        reported_by: { type: Sequelize.UUID, allowNull: false },
        inspected_by: { type: Sequelize.UUID, allowNull: true },
        rework_executor_id: { type: Sequelize.UUID, allowNull: true },
        inspection_history: {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: [],
        },
        issue: { type: Sequelize.STRING(2000), allowNull: false },
        disposition: { type: Sequelize.STRING(24), allowNull: true },
        affected_quantity: { type: Sequelize.INTEGER, allowNull: false },
        approved_quantity: { type: Sequelize.INTEGER, allowNull: false },
        rejected_quantity: { type: Sequelize.INTEGER, allowNull: false },
        status: { type: Sequelize.STRING(16), allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false },
      },
      {
        sequelize,
        tableName: 'service_order_qualities',
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
    this.belongsTo(models.ServiceOrderProduct, {
      foreignKey: 'product_id',
      as: 'product',
    });
    this.belongsTo(models.User, {
      foreignKey: 'reported_by',
      as: 'reportedBy',
    });
    this.belongsTo(models.User, {
      foreignKey: 'inspected_by',
      as: 'inspectedBy',
    });
  }
}

export default ServiceOrderQuality;
