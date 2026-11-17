import Sequelize, { Model } from 'sequelize';

class ServiceOrderAssignment extends Model {
  static init(sequelize) {
    super.init(
      {
        id: {
          type: Sequelize.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.UUIDV4,
        },
        service_order_id: { type: Sequelize.UUID, allowNull: false },
        product_id: { type: Sequelize.UUID, allowNull: false },
        sector_id: { type: Sequelize.UUID, allowNull: false },
        assigned_user_id: { type: Sequelize.UUID, allowNull: false },
        assigned_by: { type: Sequelize.UUID, allowNull: false },
        quantity: { type: Sequelize.INTEGER, allowNull: false },
        executed_quantity: { type: Sequelize.INTEGER, allowNull: false },
        remaining_quantity: { type: Sequelize.INTEGER, allowNull: false },
        status: { type: Sequelize.STRING(16), allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false },
      },
      {
        sequelize,
        tableName: 'service_order_assignments',
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
      foreignKey: 'assigned_user_id',
      as: 'assignee',
    });
    this.belongsTo(models.User, {
      foreignKey: 'assigned_by',
      as: 'assignedBy',
    });
  }
}

export default ServiceOrderAssignment;
