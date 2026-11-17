'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const uuidFk = (table) => ({
      type: Sequelize.UUID,
      allowNull: false,
      references: { model: table, key: 'id' },
      onUpdate: 'RESTRICT',
      onDelete: 'RESTRICT',
    });
    const now = {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    };

    await queryInterface.createTable('service_order_counters', {
      sector_id: { ...uuidFk('sectors'), primaryKey: true },
      next_number: {
        type: Sequelize.BIGINT,
        allowNull: false,
        defaultValue: 1,
      },
      updated_at: now,
    });

    await queryInterface.createTable('service_orders', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      external_number: { type: Sequelize.STRING(64), allowNull: false },
      client_id: uuidFk('client'),
      sector_id: uuidFk('sectors'),
      due_at: { type: Sequelize.DATE, allowNull: false },
      notes: { type: Sequelize.STRING(4000), allowNull: true },
      public_status: { type: Sequelize.STRING(32), allowNull: false },
      administrative_state: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'ACTIVE',
      },
      operational_version: {
        type: Sequelize.BIGINT,
        allowNull: false,
        defaultValue: 0,
      },
      queue_entered_at: now,
      production_completed: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      created_by: uuidFk('users'),
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE service_orders
      ADD CONSTRAINT service_orders_sector_external_number_ckey
      UNIQUE (sector_id, external_number)
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE service_orders
      ADD CONSTRAINT service_orders_administrative_state_chk
      CHECK (administrative_state IN ('ACTIVE','SUSPENDED','CLOSED','CANCELLED'))
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX service_orders_queue_idx
      ON service_orders (sector_id, administrative_state, queue_entered_at)
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX service_orders_fifo_idx
      ON service_orders (
        sector_id,
        administrative_state,
        queue_entered_at ASC,
        (external_number::numeric) ASC,
        id ASC
      );
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX service_orders_client_created_idx
      ON service_orders (client_id, created_at)
    `);

    await queryInterface.createTable('service_order_products', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      service_order_id: { ...uuidFk('service_orders'), onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(240), allowNull: false },
      description: { type: Sequelize.STRING(2000), allowNull: true },
      quantity: { type: Sequelize.INTEGER, allowNull: false },
      unit_code: {
        type: Sequelize.STRING(2),
        allowNull: false,
        defaultValue: 'UN',
      },
      measurements: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
      },
      specification_revision: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      completed_quantity: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      blocked_quantity: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE service_order_products
        ADD CONSTRAINT service_order_products_quantity_ck CHECK (quantity > 0),
        ADD CONSTRAINT service_order_products_unit_ck CHECK (unit_code = 'UN'),
        ADD CONSTRAINT service_order_products_revision_ck CHECK (specification_revision > 0),
        ADD CONSTRAINT service_order_products_progress_ck CHECK (completed_quantity >= 0 AND blocked_quantity >= 0 AND completed_quantity + blocked_quantity <= quantity);
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX service_order_products_order_idx
      ON service_order_products (service_order_id, created_at, id)
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE service_order_products
      ADD CONSTRAINT service_order_products_order_id_id_uq
      UNIQUE (service_order_id, id)
    `);

    await queryInterface.createTable('service_order_assignments', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      service_order_id: uuidFk('service_orders'),
      product_id: { ...uuidFk('service_order_products'), onDelete: 'RESTRICT' },
      sector_id: uuidFk('sectors'),
      assigned_user_id: uuidFk('users'),
      assigned_by: uuidFk('users'),
      quantity: { type: Sequelize.INTEGER, allowNull: false },
      executed_quantity: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      remaining_quantity: { type: Sequelize.INTEGER, allowNull: false },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'ACTIVE',
      },
      created_at: now,
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE service_order_assignments
        ADD CONSTRAINT service_order_assignments_product_order_fk
        FOREIGN KEY (service_order_id, product_id)
        REFERENCES service_order_products (service_order_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE service_order_assignments
        ADD CONSTRAINT service_order_assignments_quantity_ck CHECK (quantity > 0 AND executed_quantity >= 0 AND remaining_quantity >= 0 AND executed_quantity + remaining_quantity = quantity),
        ADD CONSTRAINT service_order_assignments_status_ck CHECK (status IN ('ACTIVE','SUSPENDED','RELEASED','REASSIGNED','COMPLETED'));
      CREATE INDEX service_order_assignments_active_idx ON service_order_assignments (product_id, assigned_user_id) WHERE status = 'ACTIVE';
    `);

    await queryInterface.createTable('service_order_events', {
      event_id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      aggregate_id: { ...uuidFk('service_orders'), onDelete: 'RESTRICT' },
      aggregate_version: { type: Sequelize.BIGINT, allowNull: false },
      schema_version: { type: Sequelize.INTEGER, allowNull: false },
      event_type: { type: Sequelize.STRING(80), allowNull: false },
      actor_user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'RESTRICT',
        onDelete: 'RESTRICT',
      },
      sector_id: uuidFk('sectors'),
      product_item_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'service_order_products', key: 'id' },
        onUpdate: 'RESTRICT',
        onDelete: 'RESTRICT',
      },
      revision: { type: Sequelize.INTEGER, allowNull: true },
      cycle: { type: Sequelize.INTEGER, allowNull: true },
      correlation_id: { type: Sequelize.UUID, allowNull: true },
      payload: { type: Sequelize.JSONB, allowNull: false },
      occurred_at: now,
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE service_order_events
      ADD CONSTRAINT service_order_events_aggregate_version_uq
      UNIQUE (aggregate_id, aggregate_version)
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE service_order_events
        ADD CONSTRAINT service_order_events_version_ck CHECK (aggregate_version > 0),
        ADD CONSTRAINT service_order_events_schema_ck CHECK (schema_version > 0);
      CREATE INDEX service_order_events_replay_idx ON service_order_events (aggregate_id, aggregate_version);
      CREATE INDEX service_order_events_item_idx ON service_order_events (aggregate_id, product_item_id, aggregate_version);
      CREATE FUNCTION reject_service_order_event_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'service order events are append-only' USING ERRCODE = '55000'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER service_order_events_append_only BEFORE UPDATE OR DELETE ON service_order_events
        FOR EACH ROW EXECUTE FUNCTION reject_service_order_event_mutation();
      CREATE TRIGGER service_order_events_no_truncate BEFORE TRUNCATE ON service_order_events
        FOR EACH STATEMENT EXECUTE FUNCTION reject_service_order_event_mutation();
    `);

    await queryInterface.createTable('service_order_outbox', {
      event_id: {
        type: Sequelize.UUID,
        primaryKey: true,
        allowNull: false,
        references: { model: 'service_order_events', key: 'event_id' },
        onUpdate: 'RESTRICT',
        onDelete: 'RESTRICT',
      },
      aggregate_id: uuidFk('service_orders'),
      aggregate_version: { type: Sequelize.BIGINT, allowNull: false },
      schema_version: { type: Sequelize.INTEGER, allowNull: false },
      event_type: { type: Sequelize.STRING(80), allowNull: false },
      payload: { type: Sequelize.JSONB, allowNull: false },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      available_at: now,
      locked_until: { type: Sequelize.DATE, allowNull: true },
      locked_by: { type: Sequelize.UUID, allowNull: true },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      created_at: now,
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE service_order_outbox
        ADD CONSTRAINT service_order_outbox_status_ck CHECK (status IN ('PENDING','PROCESSING','PUBLISHED','PARKED')),
        ADD CONSTRAINT service_order_outbox_attempts_ck CHECK (attempts >= 0);
      CREATE INDEX service_order_outbox_claim_idx ON service_order_outbox (available_at, created_at) WHERE status = 'PENDING';
    `);

    await queryInterface.createTable('service_order_operation_grants', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      user_id: uuidFk('users'),
      sector_id: uuidFk('sectors'),
      operation: { type: Sequelize.STRING(64), allowNull: false },
      granted_by: uuidFk('users'),
      created_at: now,
      reason: { type: Sequelize.STRING(500), allowNull: false },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
      revoked_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'RESTRICT',
        onDelete: 'RESTRICT',
      },
      revoked_reason: { type: Sequelize.STRING(500), allowNull: true },
    });
    await queryInterface.sequelize.query(`
      CREATE INDEX service_order_grants_lookup_idx ON service_order_operation_grants (user_id, sector_id, operation);
      CREATE UNIQUE INDEX service_order_grants_ever_uq ON service_order_operation_grants (user_id, sector_id, operation) WHERE revoked_at IS NULL;
      CREATE FUNCTION reject_service_order_grant_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'service order grants are immutable; revoke and re-grant with audit events' USING ERRCODE = '55000'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER service_order_grants_append_only BEFORE DELETE ON service_order_operation_grants
        FOR EACH ROW EXECUTE FUNCTION reject_service_order_grant_mutation();
      CREATE TRIGGER service_order_grants_no_truncate BEFORE TRUNCATE ON service_order_operation_grants
        FOR EACH STATEMENT EXECUTE FUNCTION reject_service_order_grant_mutation();
    `);

    await queryInterface.createTable('service_order_grant_events', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      grant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'service_order_operation_grants', key: 'id' },
        onUpdate: 'RESTRICT',
        onDelete: 'RESTRICT',
      },
      actor_user_id: uuidFk('users'),
      target_user_id: uuidFk('users'),
      sector_id: uuidFk('sectors'),
      operation: { type: Sequelize.STRING(64), allowNull: false },
      action: { type: Sequelize.STRING(8), allowNull: false },
      reason: { type: Sequelize.STRING(500), allowNull: false },
      occurred_at: now,
      audit_hash: { type: Sequelize.STRING(64), allowNull: false },
      audit_previous_hash: { type: Sequelize.STRING(64), allowNull: false },
    });
    await queryInterface.sequelize.query(`
      CREATE FUNCTION reject_service_order_grant_event_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'service order grant events are append-only' USING ERRCODE = '55000'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER service_order_grant_events_append_only BEFORE UPDATE OR DELETE ON service_order_grant_events
        FOR EACH ROW EXECUTE FUNCTION reject_service_order_grant_event_mutation();
      CREATE TRIGGER service_order_grant_events_no_truncate BEFORE TRUNCATE ON service_order_grant_events
        FOR EACH STATEMENT EXECUTE FUNCTION reject_service_order_grant_event_mutation();
    `);
    await queryInterface.createTable('service_order_permissions', {
      grant_id: {
        type: Sequelize.UUID,
        primaryKey: true,
        allowNull: false,
        references: { model: 'service_order_operation_grants', key: 'id' },
        onUpdate: 'RESTRICT',
        onDelete: 'CASCADE',
      },
      user_id: uuidFk('users'),
      sector_id: uuidFk('sectors'),
      operation: { type: Sequelize.STRING(64), allowNull: false },
    });
    await queryInterface.createTable('service_order_qualities', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      service_order_id: uuidFk('service_orders'),
      product_id: { type: Sequelize.UUID, allowNull: false },
      reported_by: uuidFk('users'),
      inspected_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'RESTRICT',
        onDelete: 'RESTRICT',
      },
      rework_executor_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'RESTRICT',
        onDelete: 'RESTRICT',
      },
      inspection_history: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      issue: { type: Sequelize.STRING(2000), allowNull: false },
      disposition: { type: Sequelize.STRING(24), allowNull: true },
      affected_quantity: { type: Sequelize.INTEGER, allowNull: false },
      approved_quantity: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      rejected_quantity: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'OPEN',
      },
      created_at: now,
    });
    await queryInterface.createTable('service_order_cycles', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      service_order_id: uuidFk('service_orders'),
      cycle_number: { type: Sequelize.INTEGER, allowNull: false },
      reason: { type: Sequelize.STRING(1000), allowNull: false },
      reopened_by: uuidFk('users'),
      scope: { type: Sequelize.JSONB, allowNull: false },
      active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: now,
      closed_at: { type: Sequelize.DATE, allowNull: true },
    });
    await queryInterface.createTable('service_order_projection_checkpoints', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      service_order_id: uuidFk('service_orders'),
      consumer_name: { type: Sequelize.STRING(80), allowNull: false },
      read_model_version: {
        type: Sequelize.BIGINT,
        allowNull: false,
        defaultValue: 0,
      },
      generation: { type: Sequelize.STRING(80), allowNull: false },
      updated_at: now,
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE service_order_projection_checkpoints
      ADD CONSTRAINT service_order_projection_checkpoint_uq
      UNIQUE (service_order_id, generation)
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE service_order_cycles ADD CONSTRAINT service_order_cycles_number_ck CHECK (cycle_number > 0);
      CREATE UNIQUE INDEX service_order_cycles_number_uq ON service_order_cycles (service_order_id, cycle_number);
      CREATE UNIQUE INDEX service_order_cycles_one_active_uq ON service_order_cycles (service_order_id) WHERE active;
      CREATE FUNCTION reject_service_order_cycle_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'service order cycles are append-only' USING ERRCODE = '55000'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER service_order_cycles_append_only BEFORE UPDATE OR DELETE ON service_order_cycles
        FOR EACH ROW EXECUTE FUNCTION reject_service_order_cycle_mutation();
      CREATE TRIGGER service_order_cycles_no_truncate BEFORE TRUNCATE ON service_order_cycles
        FOR EACH STATEMENT EXECUTE FUNCTION reject_service_order_cycle_mutation();
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE service_order_qualities
        ADD CONSTRAINT service_order_qualities_quantity_ck CHECK (affected_quantity > 0 AND approved_quantity >= 0 AND rejected_quantity >= 0 AND approved_quantity + rejected_quantity <= affected_quantity),
        ADD CONSTRAINT service_order_qualities_status_ck CHECK (status IN ('OPEN','REWORK','APPROVED','REJECTED')),
        ADD CONSTRAINT service_order_qualities_inspector_ck CHECK (inspected_by IS NULL OR inspected_by <> reported_by);
      CREATE INDEX service_order_qualities_open_idx ON service_order_qualities (service_order_id, product_id) WHERE status IN ('OPEN','REWORK');
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE service_order_grant_events ADD CONSTRAINT service_order_grant_events_action_ck CHECK (action IN ('GRANT','REVOKE'));
      CREATE UNIQUE INDEX service_order_permissions_active_uq ON service_order_permissions (user_id, sector_id, operation);
    `);
  },

  async down(queryInterface) {
    const tables = [
      'service_order_counters',
      'service_orders',
      'service_order_products',
      'service_order_assignments',
      'service_order_events',
      'service_order_outbox',
      'service_order_operation_grants',
      'service_order_grant_events',
      'service_order_permissions',
      'service_order_qualities',
      'service_order_cycles',
      'service_order_projection_checkpoints',
    ];
    for (const table of tables) {
      const exists = await queryInterface.tableExists(table);
      if (exists) {
        const rows = await queryInterface.sequelize.query(
          `SELECT EXISTS (SELECT 1 FROM "${table}" LIMIT 1) AS has_rows`,
          { type: queryInterface.sequelize.QueryTypes.SELECT },
        );
        if (rows[0]?.has_rows) {
          throw new Error(
            `Refusing destructive Feature 004 rollback: ${table} contains rows`,
          );
        }
      }
    }
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS service_order_grant_events_append_only ON service_order_grant_events;
      DROP TRIGGER IF EXISTS service_order_grant_events_no_truncate ON service_order_grant_events;
      DROP FUNCTION IF EXISTS reject_service_order_grant_event_mutation();
      DROP TRIGGER IF EXISTS service_order_grants_append_only ON service_order_operation_grants;
      DROP TRIGGER IF EXISTS service_order_grants_no_truncate ON service_order_operation_grants;
      DROP FUNCTION IF EXISTS reject_service_order_grant_mutation();
      DROP TRIGGER IF EXISTS service_order_events_append_only ON service_order_events;
      DROP TRIGGER IF EXISTS service_order_events_no_truncate ON service_order_events;
      DROP FUNCTION IF EXISTS reject_service_order_event_mutation();
      DROP TRIGGER IF EXISTS service_order_cycles_append_only ON service_order_cycles;
      DROP TRIGGER IF EXISTS service_order_cycles_no_truncate ON service_order_cycles;
      DROP FUNCTION IF EXISTS reject_service_order_cycle_mutation();
    `);
    for (const table of [...tables].reverse()) {
      if (await queryInterface.tableExists(table))
        await queryInterface.dropTable(table);
    }
    await queryInterface.sequelize.query(
      'DROP INDEX IF EXISTS service_orders_fifo_idx',
    );
  },
};
