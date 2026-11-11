'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('auth_sessions', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      actor_type: { type: Sequelize.STRING(16), allowNull: false },
      user_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      client_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'client', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
      revocation_reason: { type: Sequelize.STRING(32), allowNull: true },
      last_used_at: { type: Sequelize.DATE, allowNull: true },
    })
    await queryInterface.sequelize.query("ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_actor_owner_check CHECK ((actor_type = 'user' AND user_id IS NOT NULL AND client_id IS NULL) OR (actor_type = 'client' AND client_id IS NOT NULL AND user_id IS NULL))")
    await queryInterface.addIndex('auth_sessions', ['user_id', 'expires_at'], { name: 'auth_sessions_user_expiry_idx' })
    await queryInterface.addIndex('auth_sessions', ['client_id', 'expires_at'], { name: 'auth_sessions_client_expiry_idx' })
    await queryInterface.createTable('auth_session_refresh_tokens', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      session_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'auth_sessions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      token_hash: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      consumed_at: { type: Sequelize.DATE, allowNull: true },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
    })
    await queryInterface.addIndex('auth_session_refresh_tokens', ['session_id', 'consumed_at', 'revoked_at'], { name: 'auth_session_refresh_current_idx' })
  },
  async down(queryInterface) {
    await queryInterface.dropTable('auth_session_refresh_tokens')
    await queryInterface.dropTable('auth_sessions')
  },
}