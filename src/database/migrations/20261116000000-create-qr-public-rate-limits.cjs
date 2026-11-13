'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('qr_public_rate_limits', {
      origin_hash: { type: Sequelize.STRING(64), primaryKey: true, allowNull: false },
      window_started_at: { type: Sequelize.DATE, allowNull: false },
      request_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      expires_at: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.sequelize.query(`
      ALTER TABLE qr_public_rate_limits
        ADD CONSTRAINT qr_public_rate_limits_origin_hash_ck CHECK (origin_hash ~ '^[a-f0-9]{64}$'),
        ADD CONSTRAINT qr_public_rate_limits_request_count_ck CHECK (request_count BETWEEN 0 AND 6);
      CREATE INDEX qr_public_rate_limits_expires_at_idx ON qr_public_rate_limits (expires_at);
    `)
  },

  async down() {
    throw new Error('QR public rate-limit records are security state; remove only through an explicitly approved retention procedure')
  },
}