import Sequelize, { Model } from 'sequelize'

class StockMovements extends Model {
  static init(sequelize) {
    super.init(
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          allowNull: false,
          primaryKey: true,
        },
        item_id: {
          type: Sequelize.UUID,
          allowNull: false,
        },
        item_name_snapshot: {
          type: Sequelize.STRING,
          allowNull: false,
        },
        movement_type: {
          type: Sequelize.ENUM('IN', 'OUT'),
          allowNull: false,
        },
        quantity: {
          type: Sequelize.INTEGER,
          allowNull: false,
          validate: {
            min: 1,
          },
        },
        user_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        withdrawn_by: {
          type: Sequelize.STRING,
          allowNull: true,
        },
        added_by: {
          type: Sequelize.STRING,
          allowNull: true,
        },
        authorized_by: {
          type: Sequelize.STRING,
          allowNull: true,
        },
        note: {
          type: Sequelize.STRING,
          allowNull: true,
        },
      },
      {
        sequelize,
        tableName: 'stock_movements',
        timestamps: true,
        underscored: true,
      },
    )

    return this
  }

  static associate(models) {
    this.belongsTo(models.Product, {
      foreignKey: 'product_id',
      as: 'item',
    })

    this.belongsTo(models.User, {
      foreignKey: 'user_id',
      as: 'client',
    })
  }
}

export default StockMovements
