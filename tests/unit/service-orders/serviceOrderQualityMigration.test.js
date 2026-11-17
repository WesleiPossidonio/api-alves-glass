import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import Sequelize from 'sequelize';

const require = createRequire(import.meta.url);
const migration = require('../../../src/database/migrations/20261125000000-link-quality-reinspections.cjs');

const complete = {
  column_exists: true,
  column_matches: true,
  constraint_count: 1,
  fk_matches: true,
  index_exists: true,
  index_matches: true,
};

function setup(state, ready = true) {
  const calls = [];
  const transaction = {};
  return {
    calls,
    queryInterface: {
      sequelize: {
        transaction: async (fn) => fn(transaction),
        query: async (sql, options) => {
          assert.strictEqual(options.transaction, transaction);
          calls.push(sql);
          if (sql.includes('SequelizeMeta')) return [[{ ready }]];
          if (sql.startsWith('LOCK TABLE')) return [[]];
          return [[state]];
        },
      },
      addColumn: async (...args) => calls.push(['column', ...args]),
      addIndex: async (...args) => calls.push(['index', ...args]),
    },
  };
}

test('migration 250 recognizes only the complete equivalent schema without DDL or DML', async () => {
  const { queryInterface, calls } = setup(complete);
  await migration.up(queryInterface, Sequelize);
  assert.equal(calls.length, 3);
  assert.equal(
    calls.some((call) => Array.isArray(call)),
    false,
  );
  assert.equal(
    calls.some((sql) => /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE)\b/.test(sql)),
    false,
  );
});

test('migration 250 rejects missing prerequisites before schema inspection', async () => {
  const { queryInterface, calls } = setup(complete, false);
  await assert.rejects(
    migration.up(queryInterface, Sequelize),
    /requires migration 240/,
  );
  assert.equal(calls.length, 1);
});

test('migration 250 rejects partial or divergent objects without attempting repair', async () => {
  for (const delta of [
    { column_matches: false },
    { constraint_count: 0 },
    { constraint_count: 2 },
    { fk_matches: false },
    { index_exists: false },
    { index_matches: false },
    { column_exists: false },
  ]) {
    const { queryInterface, calls } = setup({ ...complete, ...delta });
    await assert.rejects(
      migration.up(queryInterface, Sequelize),
      /partial or divergent/,
    );
    assert.equal(
      calls.some((call) => Array.isArray(call)),
      false,
    );
  }
});

test('migration 250 retains additive creation when all its objects are absent', async () => {
  const { queryInterface, calls } = setup({
    column_exists: false,
    column_matches: false,
    constraint_count: 0,
    fk_matches: false,
    index_exists: false,
    index_matches: false,
  });
  await migration.up(queryInterface, Sequelize);
  assert.equal(calls[3][0], 'column');
  assert.equal(calls[3][2], 'parent_quality_id');
  assert.equal(calls[3][3].onDelete, 'RESTRICT');
  assert.equal(calls[4][0], 'index');
  assert.equal(calls[4][3].name, 'service_order_qualities_parent_idx');
});

test('migration 250 remains forward-only', async () => {
  await assert.rejects(migration.down(), /Forward-only/);
});
