'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('inventory_outbox', {
      event_id: {
        type: Sequelize.UUID,
        primaryKey: true,
        allowNull: false,
        references: { model: 'inventory_events', key: 'id' },
        onUpdate: 'RESTRICT',
        onDelete: 'RESTRICT',
      },
      schema_version: { type: Sequelize.INTEGER, allowNull: false },
      aggregate_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'materials', key: 'id' },
        onUpdate: 'RESTRICT',
        onDelete: 'RESTRICT',
      },
      aggregate_version: { type: Sequelize.BIGINT, allowNull: false },
      event_type: { type: Sequelize.STRING(32), allowNull: false },
      payload: { type: Sequelize.JSONB, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'PENDING' },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      locked_until: { type: Sequelize.DATE, allowNull: true },
      locked_by: { type: Sequelize.UUID, allowNull: true },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      available_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    })
    await queryInterface.addIndex('inventory_outbox', ['status', 'available_at', 'created_at'], { name: 'inventory_outbox_pending_idx' })
    await queryInterface.addIndex('inventory_outbox', ['aggregate_id', 'aggregate_version'], { name: 'inventory_outbox_aggregate_version_uq', unique: true })
    await queryInterface.sequelize.query(`
      ALTER TABLE inventory_outbox
        ADD CONSTRAINT inventory_outbox_schema_version_ck CHECK (schema_version > 0),
        ADD CONSTRAINT inventory_outbox_aggregate_version_ck CHECK (aggregate_version > 0),
        ADD CONSTRAINT inventory_outbox_status_ck CHECK (status IN ('PENDING','PROCESSING','RETRY','PUBLISHED','DEAD')),
        ADD CONSTRAINT inventory_outbox_attempts_ck CHECK (attempts >= 0),
        ADD CONSTRAINT inventory_outbox_lease_ck CHECK ((locked_until IS NULL) = (locked_by IS NULL)),
        ADD CONSTRAINT inventory_outbox_processing_lease_ck CHECK ((status = 'PROCESSING') = (locked_until IS NOT NULL));
    `)
    await queryInterface.createTable('inventory_event_snapshots', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false },
      material_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'materials', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      version: { type: Sequelize.BIGINT, allowNull: false },
      balance: { type: Sequelize.NUMERIC, allowNull: false },
      state: { type: Sequelize.JSONB, allowNull: false },
      checksum: { type: Sequelize.STRING(64), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    })
    await queryInterface.addIndex('inventory_event_snapshots', ['material_id', 'version'], { name: 'inventory_event_snapshots_material_version_uq', unique: true })
    await queryInterface.sequelize.query(`
      ALTER TABLE inventory_event_snapshots
        ADD CONSTRAINT inventory_event_snapshots_version_ck CHECK (version > 0),
        ADD CONSTRAINT inventory_event_snapshots_checksum_ck CHECK (checksum ~ '^[0-9a-f]{64}$');
    `)
  },

  async down(queryInterface) {
    await queryInterface.dropTable('inventory_event_snapshots')
    await queryInterface.dropTable('inventory_outbox')
  },
}