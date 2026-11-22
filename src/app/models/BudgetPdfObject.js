import Sequelize, { Model } from 'sequelize';

class BudgetPdfObject extends Model {
  static init(sequelize) {
    const bigint = (name, allowNull = true) => ({
      type: Sequelize.BIGINT,
      allowNull,
      get() {
        const value = this.getDataValue(name);
        return value == null ? value : String(value);
      },
    });
    super.init(
      {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        owner_budget_id: { type: Sequelize.UUID, allowNull: false },
        bucket: { type: Sequelize.STRING(255), allowNull: false },
        object_key: { type: Sequelize.TEXT, allowNull: false },
        created_by: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'RESTRICT',
        },
        state: {
          type: Sequelize.TEXT,
          allowNull: false,
          validate: {
            isIn: [
              [
                'UPLOADING',
                'READY',
                'ATTACHED',
                'CLEANUP_PENDING',
                'CLEANING',
                'REMOVED',
              ],
            ],
          },
        },
        size_bytes: bigint('size_bytes'),
        sha256: { type: Sequelize.CHAR(64), allowNull: true },
        content_type: { type: Sequelize.TEXT, allowNull: true },
        validity_date: { type: Sequelize.DATEONLY, allowNull: false },
        expected_revision: bigint('expected_revision'),
        lease_token: { type: Sequelize.UUID, allowNull: true },
        lease_until: { type: Sequelize.DATE, allowNull: true },
        attempts: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        next_attempt_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.NOW,
        },
        last_error_code: { type: Sequelize.STRING(128), allowNull: true },
        confirmed_at: { type: Sequelize.DATE, allowNull: true },
        removed_at: { type: Sequelize.DATE, allowNull: true },
      },
      {
        sequelize,
        schema: 'public',
        tableName: 'budget_pdf_objects',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        underscored: true,
        indexes: [
          {
            unique: true,
            fields: ['id', 'owner_budget_id'],
            name: 'budget_objects_owner_uq',
          },
          {
            unique: true,
            fields: ['bucket', 'object_key'],
            name: 'budget_objects_key_uq',
          },
        ],
      },
    );
    return this;
  }
  static associate(models) {
    this.belongsTo(models.User, {
      foreignKey: 'created_by',
      as: 'creator',
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    });
  }
}
export default BudgetPdfObject;
