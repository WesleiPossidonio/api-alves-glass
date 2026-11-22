import Sequelize, { Model } from 'sequelize';

class BudgetCommercialPermissionAudit extends Model {
  static init(sequelize) {
    super.init(
      {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        actor_user_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'RESTRICT',
        },
        target_user_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
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
        action: {
          type: Sequelize.TEXT,
          allowNull: false,
          validate: {
            isIn: [['APPOINT_MANAGER', 'REVOKE_MANAGER', 'GRANT', 'REVOKE']],
          },
        },
        operation: {
          type: Sequelize.TEXT,
          allowNull: true,
          validate: {
            isIn: [
              [
                'CREATE_EDIT',
                'READ',
                'REPLACE_PDF',
                'PUBLISH',
                'DELETE',
                'MANAGE_PERMISSIONS',
              ],
            ],
          },
        },
        occurred_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.NOW,
        },
      },
      {
        sequelize,
        schema: 'public',
        tableName: 'budget_commercial_permission_audit',
        timestamps: false,
        underscored: true,
        hooks: {
          beforeUpdate() {
            throw new Error('BUDGET_PERMISSION_AUDIT_APPEND_ONLY');
          },
          beforeDestroy() {
            throw new Error('BUDGET_PERMISSION_AUDIT_APPEND_ONLY');
          },
          beforeBulkUpdate() {
            throw new Error('BUDGET_PERMISSION_AUDIT_APPEND_ONLY');
          },
          beforeBulkDestroy() {
            throw new Error('BUDGET_PERMISSION_AUDIT_APPEND_ONLY');
          },
        },
      },
    );
    return this;
  }
  static associate(models) {
    this.belongsTo(models.User, {
      foreignKey: 'actor_user_id',
      as: 'actor',
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    });
    this.belongsTo(models.User, {
      foreignKey: 'target_user_id',
      as: 'target',
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    });
    this.belongsTo(models.Sector, {
      foreignKey: 'sector_id',
      as: 'sector',
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    });
  }
}
export default BudgetCommercialPermissionAudit;
