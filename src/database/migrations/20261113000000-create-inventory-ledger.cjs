'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('inventory_events', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4, allowNull: false },
      material_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'materials', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      warehouse_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'warehouses', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      event_type: { type: Sequelize.STRING(16), allowNull: false },
      delta: { type: Sequelize.NUMERIC, allowNull: false },
      balance_before: { type: Sequelize.NUMERIC, allowNull: false },
      balance_after: { type: Sequelize.NUMERIC, allowNull: false },
      unit_code_snapshot: { type: Sequelize.STRING(8), allowNull: false },
      reason_code: { type: Sequelize.STRING(32), allowNull: true },
      description: { type: Sequelize.STRING(1000), allowNull: false },
      sequence: { type: Sequelize.BIGINT, allowNull: false },
      performed_by: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      received_by: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      command_origin: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'SESSION' },
      occurred_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      return_of_event_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'inventory_events', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      compensates_event_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'inventory_events', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
    })
    await queryInterface.addIndex('inventory_events', ['material_id', 'sequence'], { name: 'inventory_events_material_sequence_uq', unique: true })
    await queryInterface.addIndex('inventory_events', ['material_id', 'occurred_at', 'sequence'], { name: 'inventory_events_material_history_idx' })
    await queryInterface.sequelize.query(`
      ALTER TABLE inventory_events ADD CONSTRAINT inventory_events_type_ck
        CHECK (event_type IN ('IN','OUT','RETURN','ADJUSTMENT','OPENING'));
      ALTER TABLE inventory_events ADD CONSTRAINT inventory_events_balance_ck
        CHECK (balance_before >= 0 AND balance_after >= 0);
      ALTER TABLE inventory_events ADD CONSTRAINT inventory_events_delta_ck
        CHECK ((event_type IN ('IN','RETURN','OPENING') AND delta >= 0 AND balance_after = balance_before + delta)
            OR (event_type = 'OUT' AND delta <= 0 AND balance_after = balance_before + delta)
            OR (event_type = 'ADJUSTMENT' AND balance_after = balance_before + delta));
      ALTER TABLE inventory_events ADD CONSTRAINT inventory_events_origin_ck
        CHECK (command_origin IN ('SESSION','QR'));
      CREATE UNIQUE INDEX inventory_events_one_opening_per_material_uq
        ON inventory_events (material_id) WHERE event_type = 'OPENING';
      CREATE FUNCTION reject_inventory_event_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'inventory events are append-only' USING ERRCODE = '55000'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER inventory_events_append_only BEFORE UPDATE OR DELETE ON inventory_events
        FOR EACH ROW EXECUTE FUNCTION reject_inventory_event_mutation();
      CREATE TRIGGER inventory_events_no_truncate BEFORE TRUNCATE ON inventory_events
        FOR EACH STATEMENT EXECUTE FUNCTION reject_inventory_event_mutation();
    `)

    await queryInterface.createTable('movement_idempotency', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4, allowNull: false },
      warehouse_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'warehouses', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      operation_id: { type: Sequelize.UUID, allowNull: false },
      principal_type: { type: Sequelize.STRING(16), allowNull: false },
      principal_id: { type: Sequelize.UUID, allowNull: false },
      idempotency_key: { type: Sequelize.STRING(200), allowNull: false },
      request_hash: { type: Sequelize.STRING(64), allowNull: false },
      event_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'inventory_events', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      response_status: { type: Sequelize.INTEGER, allowNull: true },
      response_body: { type: Sequelize.JSONB, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    })
    await queryInterface.addIndex('movement_idempotency', ['warehouse_id', 'principal_type', 'principal_id', 'idempotency_key'], { name: 'movement_idempotency_principal_key_uq', unique: true })
    await queryInterface.addIndex('movement_idempotency', ['warehouse_id', 'operation_id'], { name: 'movement_idempotency_operation_uq', unique: true })
    await queryInterface.sequelize.query(`
      ALTER TABLE movement_idempotency ADD CONSTRAINT movement_idempotency_principal_ck
        CHECK (principal_type IN ('USER','PIN_AUTHORIZER'));
      ALTER TABLE movement_idempotency ADD CONSTRAINT movement_idempotency_hash_ck
        CHECK (request_hash ~ '^[0-9a-f]{64}$');
      CREATE FUNCTION reject_movement_idempotency_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'movement idempotency receipts are immutable' USING ERRCODE = '55000'; END IF;
        IF OLD.event_id IS NOT NULL OR NEW.id <> OLD.id OR NEW.warehouse_id <> OLD.warehouse_id
          OR NEW.operation_id <> OLD.operation_id OR NEW.principal_type <> OLD.principal_type
          OR NEW.principal_id <> OLD.principal_id OR NEW.idempotency_key <> OLD.idempotency_key
          OR NEW.request_hash <> OLD.request_hash OR NEW.created_at <> OLD.created_at
          OR NEW.event_id IS NULL OR NEW.response_status IS NULL OR NEW.response_body IS NULL THEN
          RAISE EXCEPTION 'movement idempotency receipt can only be completed once' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER movement_idempotency_no_delete BEFORE DELETE ON movement_idempotency
        FOR EACH ROW EXECUTE FUNCTION reject_movement_idempotency_mutation();
      CREATE TRIGGER movement_idempotency_complete_once BEFORE UPDATE ON movement_idempotency
        FOR EACH ROW EXECUTE FUNCTION reject_movement_idempotency_mutation();
      CREATE TRIGGER movement_idempotency_no_truncate BEFORE TRUNCATE ON movement_idempotency
        FOR EACH STATEMENT EXECUTE FUNCTION reject_movement_idempotency_mutation();
    `)
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS movement_idempotency_no_delete ON movement_idempotency')
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS movement_idempotency_complete_once ON movement_idempotency')
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS movement_idempotency_no_truncate ON movement_idempotency')
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS reject_movement_idempotency_mutation()')
    await queryInterface.dropTable('movement_idempotency')
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS inventory_events_append_only ON inventory_events')
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS inventory_events_no_truncate ON inventory_events')
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS reject_inventory_event_mutation()')
    await queryInterface.dropTable('inventory_events')
  },
}