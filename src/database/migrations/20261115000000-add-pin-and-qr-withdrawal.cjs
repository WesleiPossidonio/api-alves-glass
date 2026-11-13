'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'pin_hash', { type: Sequelize.STRING(255), allowNull: true })
    await queryInterface.addColumn('users', 'pin_lookup', { type: Sequelize.STRING(64), allowNull: true })
    await queryInterface.addColumn('users', 'pin_revoked_at', { type: Sequelize.DATE, allowNull: true })
    await queryInterface.addColumn('materials', 'qr_token_hash', { type: Sequelize.STRING(64), allowNull: true })
    await queryInterface.addColumn('materials', 'qr_revoked_at', { type: Sequelize.DATE, allowNull: true })
    await queryInterface.changeColumn('inventory_events', 'performed_by', { type: Sequelize.UUID, allowNull: true })
    await queryInterface.addColumn('inventory_events', 'withdrawn_by', {
      type: Sequelize.UUID, allowNull: true,
      references: { model: 'users', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT',
    })
    await queryInterface.addColumn('inventory_events', 'authorized_by', {
      type: Sequelize.UUID, allowNull: true,
      references: { model: 'users', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT',
    })
    await queryInterface.addIndex('users', ['pin_lookup'], {
      name: 'users_active_pin_lookup_uq', unique: true,
      where: { pin_lookup: { [Sequelize.Op.ne]: null }, pin_revoked_at: null, status_users: 'active' },
    })
    await queryInterface.addIndex('materials', ['qr_token_hash'], {
      name: 'materials_qr_token_hash_uq', unique: true,
      where: { qr_token_hash: { [Sequelize.Op.ne]: null }, qr_revoked_at: null },
    })
    await queryInterface.createTable('pin_attempts', {
      scope_hash: { type: Sequelize.STRING(64), primaryKey: true, allowNull: false },
      window_started_at: { type: Sequelize.DATE, allowNull: false },
      failures: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      blocked_until: { type: Sequelize.DATE, allowNull: true },
    })
    await queryInterface.sequelize.query(`
      ALTER TABLE pin_attempts ADD CONSTRAINT pin_attempts_failures_ck CHECK (failures BETWEEN 0 AND 5);
      CREATE TABLE pin_credential_audits (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
        actor_user_id uuid NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
        action varchar(16) NOT NULL CHECK (action IN ('SET','RESET','REVOKE')),
        reason varchar(500) NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE FUNCTION reject_pin_credential_audit_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'PIN credential audit is append-only' USING ERRCODE = '55000'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER pin_credential_audits_append_only BEFORE UPDATE OR DELETE ON pin_credential_audits
        FOR EACH ROW EXECUTE FUNCTION reject_pin_credential_audit_mutation();
      CREATE TRIGGER pin_credential_audits_no_truncate BEFORE TRUNCATE ON pin_credential_audits
        FOR EACH STATEMENT EXECUTE FUNCTION reject_pin_credential_audit_mutation();
    `)
  },

  async down() {
    throw new Error('This additive PIN/QR migration is not automatically reversible; preserve credential and ledger audit history')
  },
}