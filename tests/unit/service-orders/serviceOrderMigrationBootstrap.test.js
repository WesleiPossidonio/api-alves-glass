import assert from 'node:assert/strict';
import test from 'node:test';
import Sequelize from 'sequelize';
import baseline from '../../../src/database/migrations/20261119000000-create-service-orders.cjs';
import extension from '../../../src/database/migrations/20261120000000-extend-service-order-schema.cjs';

async function baselineColumns() {
  const columns = {};
  await baseline.up(
    {
      createTable: async (name, fields) => {
        columns[name] = Object.keys(fields);
      },
      sequelize: { query: async () => {} },
    },
    Sequelize,
  );
  return columns;
}

function extensionInterface(columns, writes) {
  return {
    sequelize: {
      transaction: (fn) => fn({}),
      query: async (sql, options = {}) => {
        if (sql.includes('to_regclass')) return [[{ relation: 'present' }]];
        if (sql.includes('information_schema.columns'))
          return [
            columns[options.replacements.table].map((column_name) => ({
              column_name,
            })),
          ];
        if (sql.includes('pg_get_triggerdef'))
          return [[{ definition: 'BEFORE DELETE' }]];
        if (sql.includes('pg_indexes'))
          return [
            [
              {
                indexname: 'service_order_grants_ever_uq',
                indexdef: '(user_id, sector_id, operation)',
              },
              {
                indexname: 'service_order_permissions_active_uq',
                indexdef: '(user_id, sector_id, operation)',
              },
            ],
          ];
        if (sql.includes('SELECT\n       (SELECT count'))
          return [[{ grants: 0, events: 0, permissions: 0 }]];
        writes.push(sql);
        return [[]];
      },
    },
  };
}

for (const layout of ['historical', 'inline']) {
  test(`migration 200 accepts only the known ${layout} baseline column layout`, async () => {
    const columns = await baselineColumns();
    if (layout === 'inline') {
      for (const [table, names, before] of [
        ['service_orders', ['notes'], 'public_status'],
        [
          'service_order_qualities',
          ['rework_executor_id', 'inspection_history'],
          'issue',
        ],
      ]) {
        columns[table] = columns[table].filter((name) => !names.includes(name));
        columns[table].splice(columns[table].indexOf(before), 0, ...names);
      }
    }
    const writes = [];
    await extension.up(extensionInterface(columns, writes));
    assert.equal(writes.length, 1);
    for (const invalid of [
      [...columns.service_orders, 'unexpected'],
      columns.service_orders.filter((name) => name !== 'due_at'),
      [...columns.service_orders].reverse(),
    ]) {
      const rejectedWrites = [];
      await assert.rejects(
        extension.up(
          extensionInterface(
            { ...columns, service_orders: invalid },
            rejectedWrites,
          ),
        ),
        /unexpected service_orders columns/,
      );
      assert.deepEqual(rejectedWrites, []);
    }
  });
}
