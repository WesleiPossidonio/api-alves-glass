import Sequelize, { Model } from 'sequelize';

class BudgetPdf extends Model {
  static init(sequelize) {
    super.init(
      {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        client_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'client', key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'RESTRICT',
        },
        sector_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'sectors', key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'RESTRICT',
        },
        created_by: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'RESTRICT',
        },
        commercial_number: { type: Sequelize.STRING(64), allowNull: false },
        administrative_name: { type: Sequelize.STRING(240), allowNull: false },
        revision: {
          type: Sequelize.BIGINT,
          allowNull: false,
          defaultValue: '1',
          get() {
            const value = this.getDataValue('revision');
            return value == null ? value : String(value);
          },
        },
        first_published_at: { type: Sequelize.DATE, allowNull: true },
        published_object_id: { type: Sequelize.UUID, allowNull: true },
        published_validity_date: { type: Sequelize.DATEONLY, allowNull: true },
        pending_object_id: { type: Sequelize.UUID, allowNull: true },
        pending_validity_date: { type: Sequelize.DATEONLY, allowNull: true },
      },
      {
        sequelize,
        schema: 'public',
        tableName: 'budgets_pdf',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        underscored: true,
        // Composite ownership FKs/CHECKs/triggers/C collation live in migrations.
        // Never sync this model: Sequelize cannot express all these invariants.
        indexes: [
          {
            unique: true,
            fields: ['sector_id', 'commercial_number'],
            name: 'budgets_pdf_number_uq',
          },
        ],
      },
    );
    return this;
  }

  static associate(models) {
    this.belongsTo(models.Client, {
      foreignKey: 'client_id',
      as: 'client',
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
      foreignKey: 'created_by',
      as: 'creator',
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    });
    this.belongsTo(models.BudgetPdfObject, {
      foreignKey: 'pending_object_id',
      as: 'pendingObject',
      constraints: false,
    });
    this.belongsTo(models.BudgetPdfObject, {
      foreignKey: 'published_object_id',
      as: 'publishedObject',
      constraints: false,
    });
  }
}
export default BudgetPdf;
