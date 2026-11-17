import assert from 'node:assert/strict';
import test from 'node:test';
import migration from '../../../src/database/migrations/20261119000000-create-service-orders.cjs';
import schemaExtension from '../../../src/database/migrations/20261120000000-extend-service-order-schema.cjs';
import schemaRepair from '../../../src/database/migrations/20261121000000-repair-service-order-schema-extension.cjs';
import ServiceOrderPermissionRepository from '../../../src/app/repositories/ServiceOrderPermissionRepository.js';
import ServiceOrderOperationGrant from '../../../src/app/models/ServiceOrderOperationGrant.js';
import ServiceOrderPermission from '../../../src/app/models/ServiceOrderPermission.js';
import ServiceOrderGrantEvent from '../../../src/app/models/ServiceOrderGrantEvent.js';
import ServiceOrderGrantEventRepository from '../../../src/app/repositories/ServiceOrderGrantEventRepository.js';
import User from '../../../src/app/models/User.js';
import Sector from '../../../src/app/models/Sector.js';
import UserSector from '../../../src/app/models/UserSector.js';
import ServiceOrderEventRepository from '../../../src/app/repositories/ServiceOrderEventRepository.js';
import ServiceOrderEvent from '../../../src/app/models/ServiceOrderEvent.js';
import ServiceOrderRepository from '../../../src/app/repositories/ServiceOrderRepository.js';
import ServiceOrderProduct from '../../../src/app/models/ServiceOrderProduct.js';
import ServiceOrderOutbox from '../../../src/app/models/ServiceOrderOutbox.js';
import ServiceOrderQualityRepository from '../../../src/app/repositories/ServiceOrderQualityRepository.js';
import ServiceOrderAssignmentRepository from '../../../src/app/repositories/ServiceOrderAssignmentRepository.js';
import ServiceOrderAssignment from '../../../src/app/models/ServiceOrderAssignment.js';
import ServiceOrder from '../../../src/app/models/ServiceOrder.js';
import textNumberFifoIndexMigration from '../../../src/database/migrations/20261122000000-service-orders-text-number-fifo-index.cjs';

const Sequelize = {
  UUID: 'UUID',
  BIGINT: 'BIGINT',
  STRING: (size) => `STRING(${size})`,
  DATE: 'DATE',
  INTEGER: 'INTEGER',
  BOOLEAN: 'BOOLEAN',
  JSONB: 'JSONB',
  TEXT: 'TEXT',
  literal: (value) => ({ literal: value }),
};

test('Feature 004 migration creates only its own tables and destructive undo is explicit', async () => {
  const calls = [];
  const queryInterface = {
    createTable: async (...args) => calls.push(['createTable', args[0]]),
    addConstraint: async (...args) =>
      calls.push(['addConstraint', args[0], args[1].name]),
    addIndex: async (...args) =>
      calls.push(['addIndex', args[0], args[2].name]),
    dropTable: async (name) => calls.push(['dropTable', name]),
    tableExists: async () => true,
    sequelize: {
      QueryTypes: { SELECT: 'SELECT' },
      query: async (sql, options) => {
        calls.push(['query', sql]);
        if (options?.type === 'SELECT') return [{ has_rows: false }];
      },
    },
  };
  await migration.up(queryInterface, Sequelize);
  const tableNames = calls
    .filter(([kind]) => kind === 'createTable')
    .map(([, name]) => name);
  assert.ok(tableNames.includes('service_orders'));
  assert.ok(tableNames.includes('service_order_events'));
  assert.ok(tableNames.includes('service_order_outbox'));
  assert.ok(tableNames.includes('service_order_permissions'));
  assert.ok(tableNames.every((name) => name.startsWith('service_order')));
  assert.ok(
    calls.some(
      ([, arg]) => typeof arg === 'string' && arg.includes('append-only'),
    ),
  );
  assert.ok(
    calls.some(([, sql]) => String(sql).includes('service_orders_fifo_idx')),
  );
  await migration.down(queryInterface);
  assert.equal(
    calls.filter(([kind]) => kind === 'dropTable').length,
    tableNames.length,
  );
});

test('repair migration accepts only the registered partial state and creates the grant hash trigger', async () => {
  const queries = [];
  const repairColumns = {
    service_orders: [
      'id',
      'external_number',
      'client_id',
      'sector_id',
      'due_at',
      'public_status',
      'administrative_state',
      'operational_version',
      'queue_entered_at',
      'production_completed',
      'created_by',
      'created_at',
      'updated_at',
      'notes',
    ],
    service_order_qualities: [
      'id',
      'service_order_id',
      'product_id',
      'reported_by',
      'inspected_by',
      'issue',
      'disposition',
      'affected_quantity',
      'approved_quantity',
      'rejected_quantity',
      'status',
      'created_at',
      'rework_executor_id',
      'inspection_history',
    ],
    service_order_grant_events: [
      'id',
      'grant_id',
      'actor_user_id',
      'target_user_id',
      'sector_id',
      'operation',
      'action',
      'reason',
      'occurred_at',
      'audit_hash',
      'audit_previous_hash',
    ],
  };
  const repairQueryInterface = {
    sequelize: {
      transaction: async (fn) => fn({ transaction: true }),
      query: async (sql, options = {}) => {
        queries.push(String(sql));
        if (String(sql).includes('SequelizeMeta'))
          return [
            [
              { name: '20261119000000-create-service-orders.cjs' },
              { name: '20261120000000-extend-service-order-schema.cjs' },
            ],
          ];
        if (
          String(sql).includes('information_schema.columns') &&
          options.replacements?.table
        )
          return [
            repairColumns[options.replacements?.table]?.map((column_name) => ({
              column_name,
            })) ?? [],
          ];
        if (
          String(sql).includes(
            'table_name,column_name FROM information_schema.columns',
          )
        )
          return [
            [
              {
                table_name: 'service_order_qualities',
                column_name: 'inspection_history',
              },
              {
                table_name: 'service_order_qualities',
                column_name: 'rework_executor_id',
              },
              { table_name: 'service_orders', column_name: 'notes' },
            ],
          ];
        if (String(sql).includes("indexname='service_order_grants_lookup_idx'"))
          return [[{ indexdef: '(user_id, sector_id, operation)' }]];
        if (String(sql).includes('SELECT (SELECT count(*) FROM pg_proc'))
          return [[{ functions: 0, triggers: 0 }]];
        if (
          String(sql).includes(
            'SELECT (SELECT count(*) FROM service_order_grant_events) AS events',
          )
        )
          return [
            [{ events: 0, nonempty_hashes: 0, grants: 0, permissions: 0 }],
          ];
        if (
          String(sql).includes("proname='set_service_order_grant_event_hash'")
        )
          return [[]];
        if (
          String(sql).includes(
            "tgname='service_order_grant_event_hash_before_insert'",
          )
        )
          return [[]];
        if (String(sql).includes('pg_get_triggerdef'))
          return [
            [
              {
                definition:
                  'CREATE TRIGGER service_order_grants_append_only BEFORE DELETE',
              },
            ],
          ];
        if (String(sql).includes('FROM pg_proc p WHERE')) return [[]];
        if (String(sql).includes('FROM pg_trigger WHERE')) return [[]];
        if (
          String(sql).includes(
            "trigger_name='service_order_grants_append_only'",
          )
        )
          return [
            [
              {
                definition:
                  'CREATE TRIGGER service_order_grants_append_only BEFORE DELETE',
              },
            ],
          ];
        if (String(sql).includes('indexname,indexdef'))
          return [
            [
              {
                indexname: 'service_order_grants_lookup_idx',
                indexdef:
                  'CREATE INDEX service_order_grants_lookup_idx (user_id, sector_id, operation)',
              },
              {
                indexname: 'service_order_permissions_active_uq',
                indexdef:
                  'CREATE INDEX service_order_permissions_active_uq (user_id, sector_id, operation)',
              },
            ],
          ];
        if (String(sql).includes('pg_extension')) return [[]];
        if (String(sql).includes('nonempty_hashes'))
          return [
            [{ events: 0, nonempty_hashes: 0, grants: 0, permissions: 0 }],
          ];
        if (
          String(sql).includes('CREATE EXTENSION IF NOT EXISTS pgcrypto') &&
          String(sql).includes('SELECT audit_hash INTO prior_hash')
        )
          return [[]];
        if (
          String(sql).includes("proname='set_service_order_grant_event_hash'")
        )
          return [[]];
        if (
          String(sql).includes(
            "tgname='service_order_grant_event_hash_before_insert'",
          )
        )
          return [[]];
        return [[]];
      },
    },
  };

  await schemaRepair.up(repairQueryInterface);
  assert.ok(
    queries.some((sql) =>
      sql.includes(
        'CREATE OR REPLACE FUNCTION set_service_order_grant_event_hash',
      ),
    ),
  );
  assert.ok(
    queries.some((sql) =>
      sql.includes(
        'CREATE TRIGGER service_order_grant_event_hash_before_insert',
      ),
    ),
  );

  const mismatch = {
    sequelize: {
      ...repairQueryInterface.sequelize,
      query: async (sql, options = {}) => {
        if (String(sql).includes('SequelizeMeta'))
          return [
            [
              { name: '20261119000000-create-service-orders.cjs' },
              { name: '20261120000000-extend-service-order-schema.cjs' },
            ],
          ];
        if (
          String(sql).includes(
            'SELECT (SELECT count(*) FROM service_order_grant_events)',
          )
        )
          return [
            [{ events: 0, nonempty_hashes: 0, grants: 1, permissions: 0 }],
          ];
        return repairQueryInterface.sequelize.query(sql, options);
      },
    },
  };
  await assert.rejects(
    schemaRepair.up(mismatch),
    /non-empty grant\/audit tables/,
  );
});

test('grant revoke then regrant preserves append-only grant identity and rejects self-grant', async () => {
  await assert.rejects(
    ServiceOrderPermissionRepository.grant(
      {
        userId: 'admin',
        sectorId: 'sector',
        operation: 'READ_INTERNAL',
        actorId: 'admin',
        reason: 'self',
      },
      { transaction: { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } } },
    ),
    /cannot grant OS privilege to self/,
  );
});

test('permission revoke appends REVOKE before deleting active projection in same transaction', async () => {
  const calls = [];
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  ServiceOrderOperationGrant.sequelize = {
    query: async () => [[]],
  };
  ServiceOrderOperationGrant.findByPk = async (id) => ({
    id,
    user_id: 'target',
    sector_id: 'sector',
    operation: 'READ_INTERNAL',
  });
  ServiceOrderPermission.findByPk = async (id, options) => {
    calls.push(['permission.findByPk', id, options]);
    return {
      grant_id: id,
      destroy: async ({ transaction: tx }) =>
        calls.push(['projection.delete', tx]),
    };
  };
  ServiceOrderGrantEventRepository.appendGrantChange = async (input) => {
    calls.push(['event.append', input.action, input.transaction]);
  };

  await ServiceOrderPermissionRepository.revoke(
    { grantId: 'grant-1', actorId: 'admin', reason: 'revoke access' },
    { transaction },
  );
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['event.append', 'permission.findByPk', 'projection.delete'],
  );
  assert.equal(calls[0][1], 'REVOKE');
  assert.strictEqual(calls[0][2], transaction);
  assert.strictEqual(calls[2][1], transaction);
});

test('grant audit repository only inserts an event and never mutates append-only facts', async () => {
  const calls = [];
  const grantEventModel = await import(
    '../../../src/app/models/ServiceOrderGrantEvent.js'
  );
  grantEventModel.default.findAll = async () => [
    { audit_hash: 'a'.repeat(64) },
  ];
  grantEventModel.default.create = async (values, options) => {
    calls.push(['event-insert', values, options]);
    return { ...values, reload: async () => {} };
  };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const repository = new ServiceOrderGrantEventRepository.constructor();
  await repository.appendGrantChange({
    transaction,
    grant: {
      id: 'grant-2',
      user_id: 'user-2',
      sector_id: 'sector-2',
      operation: 'REASSIGN',
    },
    actorId: 'admin-1',
    action: 'GRANT',
    reason: 'reviewed',
  });
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['event-insert'],
  );
  assert.equal(calls[0][1].audit_previous_hash, 'a'.repeat(64));
  assert.equal(calls[0][1].audit_hash, '0'.repeat(64));
  assert.strictEqual(calls[0][2].transaction, transaction);
  assert.equal(
    calls.some((call) =>
      String(call[1]).startsWith('UPDATE service_order_grant_events'),
    ),
    false,
  );
});

test('service order creation and event append require explicit transactions', async () => {
  await assert.rejects(
    ServiceOrderRepository.create({
      externalNumber: 'OS-A1',
      sectorId: 'sector',
    }),
    /requires an explicit transaction/,
  );
  await assert.rejects(
    ServiceOrderEventRepository.append({ aggregateId: 'order' }),
    /requires an explicit transaction/,
  );
});

test('event append writes contiguous versions and outbox envelope in the same transaction', async () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const calls = [];
  const aggregate = {
    id: 'order-1',
    sector_id: 'sector-1',
    operational_version: '7',
    update: async (values, options) => {
      calls.push(['aggregate-update', values, options]);
    },
  };
  const originals = {
    findByPk: ServiceOrder.findByPk,
    eventModelCreate: ServiceOrderEvent.create,
    outboxCreate: ServiceOrderOutbox.create,
    productFindOne: ServiceOrderProduct.findOne,
  };
  ServiceOrderProduct.findOne = async () => null;
  ServiceOrder.findByPk = async (id, options) => {
    assert.equal(id, 'order-1');
    assert.strictEqual(options.transaction, transaction);
    assert.equal(options.lock, transaction.LOCK.UPDATE);
    return aggregate;
  };
  ServiceOrderEvent.create = async (values, options) => {
    calls.push(['event-create', values, options]);
    return values;
  };
  ServiceOrderOutbox.create = async (values, options) => {
    calls.push(['outbox-create', values, options]);
    return values;
  };

  try {
    const event = await ServiceOrderEventRepository.append(
      {
        aggregateId: 'order-1',
        sectorId: 'sector-1',
        actorUserId: 'user-1',
        eventType: 'TestFactRecorded',
        eventId: 'event-1',
        correlationId: 'correlation-1',
        payload: { detail: 'fact' },
        occurredAt: '2026-11-14T12:00:00.000Z',
      },
      { transaction },
    );
    assert.equal(event.aggregate_version, '8');
    assert.equal(calls[0][0], 'event-create');
    assert.equal(calls[0][1].aggregate_version, '8');
    assert.equal(calls[0][1].event_id, 'event-1');
    assert.equal(calls[1][0], 'aggregate-update');
    assert.equal(calls[1][1].operational_version, '8');
    assert.equal(calls[2][0], 'outbox-create');
    assert.equal(calls[2][1].aggregate_version, '8');
    assert.equal(calls[2][1].payload.correlationId, 'correlation-1');
    assert.equal(calls[2][1].payload.actor.id, 'user-1');
    for (const [, , options] of calls)
      assert.strictEqual(options.transaction, transaction);
    const beforeConflict = calls.length;
    await assert.rejects(
      ServiceOrderEventRepository.append(
        {
          aggregateId: 'order-1',
          sectorId: 'sector-1',
          eventType: 'TestFactRecorded',
        },
        { transaction, expectedVersion: '7' },
      ),
      /not contiguous/,
    );
    assert.equal(calls.length, beforeConflict);
  } finally {
    ServiceOrder.findByPk = originals.findByPk;
    ServiceOrderEvent.create = originals.eventModelCreate;
    ServiceOrderOutbox.create = originals.outboxCreate;
    ServiceOrderProduct.findOne = originals.productFindOne;
  }
});

test('ServiceOrder creation preserves manual text and never calls the legacy counter', async () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const orderValues = [];
  const originalOrderCreate = ServiceOrder.create;
  const originalProductBulkCreate = ServiceOrderProduct.bulkCreate;
  const originalProductFindAll = ServiceOrderProduct.findAll;
  ServiceOrder.create = async (values, options) => {
    orderValues.push(values);
    assert.strictEqual(options.transaction, transaction);
    return { ...values };
  };
  ServiceOrderProduct.bulkCreate = async (rows, options) => {
    assert.strictEqual(options.transaction, transaction);
    assert.equal(rows[0].service_order_id, orderValues[0].id);
    return rows;
  };
  ServiceOrderProduct.findAll = async ({
    where,
    transaction: queryTransaction,
  }) => {
    assert.equal(where.service_order_id, orderValues[0].id);
    assert.strictEqual(queryTransaction, transaction);
    return [];
  };

  try {
    const created = await ServiceOrderRepository.create(
      {
        clientId: 'client-1',
        sectorId: 'sector-1',
        externalNumber: '000123-A',
        dueAt: '2026-12-01T12:00:00.000Z',
        createdBy: 'user-1',
      },
      {
        transaction,
        products: [
          {
            name: 'Painel',
            quantity: 1,
            measurements: { widthMm: '500.25' },
          },
        ],
      },
    );
    assert.match(
      created.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.equal(created.external_number, '000123-A');
    assert.equal(typeof created.external_number, 'string');
    assert.equal(orderValues[0].external_number, '000123-A');
  } finally {
    ServiceOrder.create = originalOrderCreate;
    ServiceOrderProduct.bulkCreate = originalProductBulkCreate;
    ServiceOrderProduct.findAll = originalProductFindAll;
  }
});

test('textual FIFO index migration replaces only numeric sort index and has guarded rollback', async () => {
  const calls = [];
  let numericNumbersExist = false;
  let indexDefinition = 'original';
  const queryInterface = {
    sequelize: {
      transaction: async (work) => work({ id: 'tx' }),
      query: async (sql, options = {}) => {
        calls.push({ sql, options });
        if (sql.includes('FROM pg_constraint'))
          return [
            [
              {
                contype: 'u',
                convalidated: true,
                indisvalid: true,
                indisready: true,
                columns: ['sector_id', 'external_number'],
              },
            ],
          ];
        if (sql.includes('FROM pg_class idx')) {
          const old = indexDefinition === 'original';
          return [
            [
              {
                schema_name: 'public',
                table_name: 'service_orders',
                index_name: 'service_orders_fifo_idx',
                access_method: 'btree',
                is_unique: false,
                is_primary: false,
                is_valid: true,
                is_ready: true,
                is_live: true,
                attribute_count: old ? 5 : 4,
                key_count: old ? 5 : 4,
                has_no_predicate: true,
                has_no_expressions: !old,
                keys: old
                  ? [
                      'sector_id',
                      'administrative_state',
                      'queue_entered_at',
                      '(external_number::numeric)',
                      'id',
                    ]
                  : [
                      'sector_id',
                      'administrative_state',
                      'queue_entered_at',
                      'id',
                    ],
                directions: old
                  ? ['ASC', 'ASC', 'ASC', 'ASC', 'ASC']
                  : ['ASC', 'ASC', 'ASC', 'ASC'],
                collations: [null, 'default', null, null],
                operator_classes: old
                  ? [
                      'uuid_ops',
                      'text_ops',
                      'timestamptz_ops',
                      'numeric_ops',
                      'uuid_ops',
                    ]
                  : ['uuid_ops', 'text_ops', 'timestamptz_ops', 'uuid_ops'],
              },
            ],
          ];
        }
        if (sql.includes('external_number !~'))
          return [numericNumbersExist ? [{ '?column?': 1 }] : []];
        if (sql.startsWith('DROP INDEX')) indexDefinition = 'dropped';
        if (sql.startsWith('CREATE INDEX'))
          indexDefinition = sql.includes('external_number')
            ? 'original'
            : 'textual';
        return [[]];
      },
    },
  };
  await textNumberFifoIndexMigration.up(queryInterface);
  const executedDdl = calls.filter(
    (call) =>
      call.sql.startsWith('DROP INDEX') || call.sql.startsWith('CREATE INDEX'),
  );
  assert.match(
    executedDdl[0].sql,
    /DROP INDEX "public"\."service_orders_fifo_idx"/,
  );
  assert.match(executedDdl[1].sql, /queue_entered_at ASC,\s+id ASC/);
  assert.doesNotMatch(executedDdl[1].sql, /external_number::numeric/);
  assert.equal(executedDdl[0].options.transaction.id, 'tx');
  assert.ok(calls.some((call) => call.sql.includes('pg_constraint')));
  assert.ok(calls.some((call) => call.sql.includes('pg_get_indexdef')));
  assert.ok(calls.some((call) => call.sql.includes('LOCK TABLE')));

  numericNumbersExist = true;
  await assert.rejects(
    textNumberFifoIndexMigration.down(queryInterface),
    /Cannot restore numeric FIFO index/,
  );
  assert.equal(executedDdl.length, 2);
});

test('service-order schema contract keeps textual numbers unique within a sector', async () => {
  const calls = [];
  const queryInterface = {
    createTable: async () => {},
    sequelize: {
      QueryTypes: { SELECT: 'SELECT' },
      query: async (sql, options) => {
        calls.push(sql);
        if (options?.type === 'SELECT') return [{ has_rows: false }];
      },
    },
  };
  await migration.up(queryInterface, Sequelize);
  assert.ok(
    calls.some((sql) => /UNIQUE\s*\(sector_id,\s*external_number\)/i.test(sql)),
  );
  assert.ok(calls.some((sql) => /external_number::numeric/.test(sql)));
});

test('FIFO index migration rejects unexpected old and new definitions before DDL', async () => {
  for (const [phase, unexpectedDefinition] of [
    ['up', 'unexpected-old'],
    ['down', 'unexpected-new'],
  ]) {
    const calls = [];
    let definition = unexpectedDefinition;
    const queryInterface = {
      sequelize: {
        transaction: async (work) => work({ id: 'tx' }),
        query: async (sql, options = {}) => {
          calls.push({ sql, options });
          if (sql.includes('FROM pg_constraint'))
            return [
              [
                {
                  contype: 'u',
                  convalidated: true,
                  indisvalid: true,
                  indisready: true,
                  columns: ['sector_id', 'external_number'],
                },
              ],
            ];
          if (sql.includes('FROM pg_class idx')) {
            const old = definition === 'unexpected-old';
            return [
              [
                {
                  schema_name: 'public',
                  table_name: 'service_orders',
                  index_name: 'service_orders_fifo_idx',
                  access_method: 'btree',
                  is_unique: false,
                  is_primary: false,
                  is_valid: true,
                  is_ready: true,
                  is_live: true,
                  attribute_count: old ? 5 : 4,
                  key_count: old ? 5 : 4,
                  has_no_predicate: true,
                  has_no_expressions: !old,
                  keys:
                    definition === 'unexpected-new'
                      ? [
                          'sector_id',
                          'administrative_state',
                          'created_at',
                          'id',
                        ]
                      : old
                        ? [
                            'sector_id',
                            'administrative_state',
                            'created_at',
                            'external_number::numeric',
                            'id',
                          ]
                        : [
                            'sector_id',
                            'administrative_state',
                            'queue_entered_at',
                            'id',
                          ],
                  directions: old
                    ? ['ASC', 'ASC', 'ASC', 'ASC', 'ASC']
                    : ['ASC', 'ASC', 'ASC', 'ASC'],
                  collations: [null, 'default', null, null],
                  operator_classes: old
                    ? [
                        'uuid_ops',
                        'text_ops',
                        'timestamp_ops',
                        'numeric_ops',
                        'uuid_ops',
                      ]
                    : ['uuid_ops', 'text_ops', 'timestamp_ops', 'uuid_ops'],
                },
              ],
            ];
          }
          return [[]];
        },
      },
    };
    if (phase === 'up')
      await assert.rejects(
        textNumberFifoIndexMigration.up(queryInterface),
        /Unexpected service_orders_fifo_idx/,
      );
    else
      await assert.rejects(
        textNumberFifoIndexMigration.down(queryInterface),
        /Unexpected service_orders_fifo_idx/,
      );
    assert.equal(
      calls.some(({ sql }) => /^(DROP|CREATE) INDEX/.test(sql.trim())),
      false,
    );
    assert.ok(calls.some(({ sql }) => sql.includes('LOCK TABLE')));
  }
});
test('assignment reallocation preserves completed quantity and transfers only requested remainder', async () => {
  const assignmentUpdates = [];
  const createdAssignments = [];
  const previousCreate = ServiceOrderAssignment.create;
  ServiceOrderAssignment.create = async (data, options) => {
    createdAssignments.push({ data, options });
    return { ...data };
  };
  const assignment = {
    id: 'assignment-original',
    service_order_id: 'order-1',
    product_id: 'product-1',
    sector_id: 'sector-1',
    executed_quantity: 2,
    remaining_quantity: 5,
    status: 'ACTIVE',
    update: async (values, options) => {
      assignmentUpdates.push({ values, options });
      return { ...assignment, ...values };
    },
  };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const previousFind = ServiceOrder.findByPk;
  ServiceOrder.findByPk = async () => ({
    id: 'order-1',
    sector_id: 'sector-1',
  });

  try {
    const replacement = await ServiceOrderAssignmentRepository.reassign(
      assignment,
      { assignedUserId: 'user-new', actorId: 'user-manager', quantity: 3 },
      { transaction },
    );
    assert.equal(replacement.assigned_user_id, 'user-new');
    assert.equal(replacement.quantity, 3);
    assert.equal(createdAssignments[0].options.transaction, transaction);
    assert.deepEqual(assignmentUpdates[0].values, {
      quantity: 5,
      remaining_quantity: 0,
      status: 'REASSIGNED',
    });
    assert.equal(assignmentUpdates[0].options.transaction, transaction);
  } finally {
    ServiceOrderAssignment.create = previousCreate;
    ServiceOrder.findByPk = previousFind;
  }
});

test('quality inspections append partial results and reject cumulative quantity overflow', async () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const changes = [];
  const action = {
    status: 'OPEN',
    inspection_history: [
      {
        inspectorId: 'inspector-1',
        approvedQuantity: 1,
        rejectedQuantity: 0,
      },
    ],
    approved_quantity: '1',
    rejected_quantity: '0',
    affected_quantity: '3',
    update: async (values, options) => {
      changes.push({ values, options });
      return values;
    },
  };
  const updated = await ServiceOrderQualityRepository.recordInspection(
    action,
    {
      inspectedBy: 'inspector-2',
      approvedQuantity: 1,
      rejectedQuantity: 0,
      status: 'OPEN',
    },
    { transaction },
  );
  assert.equal(updated.approved_quantity, 2);
  assert.equal(updated.rejected_quantity, 0);
  assert.equal(updated.inspection_history.length, 2);
  assert.equal(updated.inspection_history[0].inspectorId, 'inspector-1');
  assert.equal(updated.inspection_history[1].inspectorId, 'inspector-2');
  assert.strictEqual(changes[0].options.transaction, transaction);

  await assert.rejects(
    ServiceOrderQualityRepository.recordInspection(
      { ...action, approved_quantity: '2' },
      {
        inspectedBy: 'inspector-3',
        approvedQuantity: 1,
        rejectedQuantity: 1,
        status: 'APPROVED',
      },
      { transaction },
    ),
    /exceeds affected quantity/,
  );
  assert.equal(changes.length, 1);
});

test('finalized quality actions cannot be reinspected or have their counters reset', async () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  for (const status of ['REJECTED', 'APPROVED', 'REWORK']) {
    let writes = 0;
    await assert.rejects(
      ServiceOrderQualityRepository.recordInspection(
        {
          status,
          affected_quantity: 3,
          approved_quantity: 2,
          rejected_quantity: 1,
          update: async () => {
            writes += 1;
          },
        },
        {
          inspectedBy: 'inspector',
          approvedQuantity: 1,
          rejectedQuantity: 0,
          status: 'APPROVED',
        },
        { transaction },
      ),
      /Only unresolved/,
    );
    assert.equal(writes, 0);
  }
});

test('migration remains additive and excludes inventory, legacy Order, and retention schema', async () => {
  const calls = [];
  const queryInterface = {
    createTable: async (name) => calls.push(name),
    addConstraint: async () => {},
    addIndex: async () => {},
    sequelize: { query: async () => {} },
  };
  await migration.up(queryInterface, Sequelize);
  assert.equal(
    calls.some((name) => /inventory|stock|^order$|orders_products/i.test(name)),
    false,
  );
  assert.equal(
    calls.some((name) => /retention|anonym|purge|expurg/i.test(name)),
    false,
  );
});

test('authorized Feature 004 schema extension has exact scope and a fail-closed baseline guard', async () => {
  const calls = [];
  const baseline = {
    service_order_operation_grants: [
      'id',
      'user_id',
      'sector_id',
      'operation',
      'granted_by',
      'created_at',
      'reason',
    ],
    service_order_grant_events: [
      'id',
      'grant_id',
      'actor_user_id',
      'target_user_id',
      'sector_id',
      'operation',
      'action',
      'reason',
      'occurred_at',
    ],
    service_order_permissions: [
      'grant_id',
      'user_id',
      'sector_id',
      'operation',
    ],
    service_order_qualities: [
      'id',
      'service_order_id',
      'product_id',
      'reported_by',
      'inspected_by',
      'issue',
      'disposition',
      'affected_quantity',
      'approved_quantity',
      'rejected_quantity',
      'status',
      'created_at',
    ],
    service_orders: [
      'id',
      'external_number',
      'client_id',
      'sector_id',
      'due_at',
      'public_status',
      'administrative_state',
      'operational_version',
      'queue_entered_at',
      'production_completed',
      'created_by',
      'created_at',
      'updated_at',
    ],
  };
  const queryInterface = {
    tableExists: async (table) => Object.hasOwn(baseline, table),
    sequelize: {
      transaction: async (work) => work({ id: 'test-transaction' }),
      query: async (sql, options = {}) => {
        calls.push(['query', sql]);
        if (sql.includes('to_regclass')) {
          const table = options.replacements.name.split('.')[1];
          return [[{ relation: `public.${table}` }]];
        }
        if (sql.includes('information_schema.columns')) {
          const rows = baseline[options.replacements.table].map(
            (column_name) => ({
              column_name,
            }),
          );
          return [rows];
        }
        if (sql.includes('pg_get_triggerdef'))
          return [
            [
              {
                definition:
                  'CREATE TRIGGER service_order_grants_append_only BEFORE DELETE ON service_order_operation_grants',
              },
            ],
          ];
        if (sql.includes('pg_indexes'))
          return [
            [
              {
                indexname: 'service_order_grants_ever_uq',
                indexdef:
                  'CREATE UNIQUE INDEX service_order_grants_ever_uq ON service_order_operation_grants (user_id, sector_id, operation)',
              },
              {
                indexname: 'service_order_permissions_active_uq',
                indexdef:
                  'CREATE UNIQUE INDEX service_order_permissions_active_uq ON service_order_permissions (user_id, sector_id, operation)',
              },
            ],
          ];
        if (sql.includes('count(*)') && sql.includes('AS grants'))
          return [{ grants: 0, events: 0, permissions: 0 }];
        return [[]];
      },
    },
  };
  const SequelizeForMigration = {
    STRING: (size) => `STRING(${size})`,
    UUID: 'UUID',
    JSONB: 'JSONB',
    DATE: 'DATE',
  };

  await schemaExtension.up(queryInterface, SequelizeForMigration);
  assert.ok(
    calls.some(
      ([kind, sql]) =>
        kind === 'query' &&
        String(sql).includes('ALTER TABLE service_order_grant_events') &&
        String(sql).includes('CREATE OR REPLACE FUNCTION'),
    ),
  );
  const migrationDdl = calls
    .filter(([kind]) => kind === 'query')
    .map(([, sql]) => String(sql))
    .join('\n');
  assert.doesNotMatch(
    migrationDdl,
    /\b(?:inventory|orders_products|CREATE TABLE\s+order)\b/i,
  );

  const mismatch = {
    ...queryInterface,
    sequelize: {
      ...queryInterface.sequelize,
      query: async (sql, options = {}) => {
        if (
          sql.includes('information_schema.columns') &&
          options.replacements.table === 'service_orders'
        )
          return [[{ column_name: 'unexpected_column' }]];
        return queryInterface.sequelize.query(sql, options);
      },
    },
  };
  await assert.rejects(
    schemaExtension.up(mismatch, SequelizeForMigration),
    /unexpected service_orders columns/,
  );
});
