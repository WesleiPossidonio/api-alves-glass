'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_sectors', {
      user_id: { type: Sequelize.UUID, allowNull: false, primaryKey: true, references: { model: 'users', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      sector_id: { type: Sequelize.UUID, allowNull: false, primaryKey: true, references: { model: 'sectors', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      granted_by: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
    await queryInterface.createTable('sector_authorization_audits', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      actor_user_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      affected_user_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      sector_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'sectors', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      action: { type: Sequelize.ENUM('GRANT', 'REVOKE'), allowNull: false },
      reason: { type: Sequelize.STRING(500), allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    })
    await queryInterface.addIndex('sector_authorization_audits', ['affected_user_id', 'occurred_at'], { name: 'sector_auth_audit_user_time_idx' })
    await queryInterface.addIndex('sector_authorization_audits', ['sector_id', 'occurred_at'], { name: 'sector_auth_audit_sector_time_idx' })
    await queryInterface.sequelize.query(`
      CREATE FUNCTION reject_sector_audit_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'sector authorization audit is append-only' USING ERRCODE = '55000';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER sector_authorization_audits_append_only
      BEFORE UPDATE OR DELETE ON sector_authorization_audits
      FOR EACH ROW EXECUTE FUNCTION reject_sector_audit_mutation();
      CREATE TRIGGER sector_authorization_audits_no_truncate
      BEFORE TRUNCATE ON sector_authorization_audits
      FOR EACH STATEMENT EXECUTE FUNCTION reject_sector_audit_mutation();
    `)
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS sector_authorization_audits_append_only ON sector_authorization_audits')
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS sector_authorization_audits_no_truncate ON sector_authorization_audits')
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS reject_sector_audit_mutation()')
    await queryInterface.dropTable('sector_authorization_audits')
    await queryInterface.dropTable('user_sectors')
    await queryInterface.sequelize.query("DROP TYPE IF EXISTS \"enum_sector_authorization_audits_action\"")
  },
}