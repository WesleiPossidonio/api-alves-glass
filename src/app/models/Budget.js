import Sequelize, { Model } from 'sequelize'

class Budget extends Model {
  static init (sequelize) {
    super.init(
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
        },
        client_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: {
            model: 'client',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL'
        },
        name_budget: Sequelize.STRING,
        description_budget: Sequelize.STRING,
        expiration_date: Sequelize.DATE,
        total_value: Sequelize.DECIMAL(10, 2),
        pdf_object_name:  Sequelize.STRING
      },
      {
        sequelize,
        tableName: 'budget',
        freezeTableName: true
      }
    )

    return this
  }

  static associate (models) {

    this.belongsTo(models.Client, {
      foreignKey: 'client_id',
      as: 'client_budget',
    })
  }
}

export default Budget
