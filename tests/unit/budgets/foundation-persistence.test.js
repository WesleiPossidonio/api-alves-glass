import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Sequelize } from 'sequelize';
import BudgetPdf from '../../../src/app/models/BudgetPdf.js';
import BudgetPdfObject from '../../../src/app/models/BudgetPdfObject.js';
import BudgetCommercialManager from '../../../src/app/models/BudgetCommercialManager.js';
import BudgetCommercialPermission from '../../../src/app/models/BudgetCommercialPermission.js';
import BudgetCommercialPermissionAudit from '../../../src/app/models/BudgetCommercialPermissionAudit.js';
import { BudgetPdfRepositoryClient } from '../../../src/app/repositories/BudgetPdfRepository.js';
import { BudgetPdfObjectRepositoryClient } from '../../../src/app/repositories/BudgetPdfObjectRepository.js';
import { BudgetCommercialAuthorizationRepositoryClient } from '../../../src/app/repositories/BudgetCommercialAuthorizationRepository.js';

const require = createRequire(import.meta.url);
const lifecycle = require('../../../src/database/migrations/20261130000000-enforce-budget-pdf-lifecycle.cjs');
const transaction = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } };

test('T011 emits additive lifecycle/identity/revision/deferred integrity and protected down in one transaction', async () => {
  const calls = [];
  let populated = false;
  const qi = {
    sequelize: {
      transaction: async (callback) => callback(transaction),
      query: async (sql, options) => {
        assert.equal(options.transaction, transaction);
        calls.push(sql);
        if (sql.includes('SequelizeMeta')) return [[{ name: 'prerequisite' }]];
        if (sql.includes('AS populated')) return [[{ populated }]];
        return [[]];
      },
    },
  };
  await lifecycle.up(qi);
  const sql = calls.join('\n');
  for (const fragment of [
    'DEFERRABLE INITIALLY DEFERRED',
    'OLD.revision + 1',
    'BUDGET_IDENTITY_IMMUTABLE',
    'BUDGET_PUBLISHED_IDENTITY_IMMUTABLE',
    'BUDGET_OBJECT_REGISTRY_MUST_SURVIVE',
    'BUDGET_OBJECT_METADATA_IMMUTABLE',
    'BUDGET_OBJECT_TRANSITION_INVALID',
    'BUDGET_SLOT_REQUIRES_ATTACHED_OBJECT',
    'BUDGET_OBJECT_REFERENCE_STATE_MISMATCH',
    'BUDGET_OBJECT_REVISION_OR_VALIDITY_MISMATCH',
  ])
    assert.ok(sql.includes(fragment), fragment);
  assert.doesNotMatch(sql, /ALTER TABLE|CREATE TABLE|public\.budget\b|CASCADE/);
  populated = true;
  await assert.rejects(
    lifecycle.down(qi),
    /BUDGET_ROLLBACK_REQUIRES_EMPTY_TABLES/,
  );
  assert.equal(
    calls.some((call) => call.includes('DROP TRIGGER')),
    false,
  );
  populated = false;
  await lifecycle.down(qi);
  assert.match(calls.join('\n'), /ACCESS EXCLUSIVE MODE/);
  assert.match(
    calls.join('\n'),
    /DROP FUNCTION public.budget_pdf_object_guard/,
  );
});

test('T012 model metadata aligns tables/nullability, civil dates, PKs and lossless bigint without connecting', async () => {
  const db = new Sequelize('synthetic', 'synthetic', 'synthetic', {
    dialect: 'postgres',
    logging: false,
  });
  try {
    for (const model of [
      BudgetPdf,
      BudgetPdfObject,
      BudgetCommercialManager,
      BudgetCommercialPermission,
      BudgetCommercialPermissionAudit,
    ])
      model.init(db);
    assert.equal(BudgetPdf.getTableName().tableName, 'budgets_pdf');
    assert.equal(
      BudgetPdf.rawAttributes.pending_validity_date.type.key,
      'DATEONLY',
    );
    assert.equal(BudgetPdfObject.rawAttributes.validity_date.allowNull, false);
    assert.equal(BudgetPdfObject.rawAttributes.sha256.type.key, 'CHAR');
    assert.equal(
      BudgetPdfObject.rawAttributes.owner_budget_id.references,
      undefined,
    );
    assert.deepEqual(BudgetCommercialManager.primaryKeyAttributes, [
      'user_id',
      'sector_id',
    ]);
    assert.deepEqual(BudgetCommercialPermission.primaryKeyAttributes, [
      'user_id',
      'sector_id',
      'operation',
    ]);
    assert.equal(BudgetCommercialPermissionAudit.options.timestamps, false);
    assert.equal(
      BudgetPdf.build({ revision: '9007199254740993' }).toJSON().revision,
      '9007199254740993',
    );
    assert.equal(
      BudgetPdfObject.build({ size_bytes: '10485760' }).toJSON().size_bytes,
      '10485760',
    );
    const index = readFileSync(
      new URL('../../../src/database/index.js', import.meta.url),
      'utf8',
    );
    for (const name of [
      'BudgetPdf',
      'BudgetPdfObject',
      'BudgetCommercialManager',
      'BudgetCommercialPermission',
      'BudgetCommercialPermissionAudit',
    ])
      assert.ok(index.includes(`  ${name},`));
    await assert.rejects(
      BudgetCommercialPermissionAudit.runHooks('beforeBulkUpdate'),
      /APPEND_ONLY/,
    );
  } finally {
    await db.close();
  }
});

test('T013 budget repository requires transaction and preserves bigint CAS, lock scope and both slot references', async () => {
  const calls = [];
  let count = 1;
  const model = {
    sequelize: {
      query: async (sql, options) => {
        calls.push([sql, options]);
        return [];
      },
    },
    findByPk: async (id, options) => {
      calls.push([id, options]);
      return { id };
    },
    update: async (values, options) => {
      calls.push([values, options]);
      return [count, [values]];
    },
  };
  const repo = new BudgetPdfRepositoryClient(model);
  await assert.rejects(repo.lockBudget('b'), /TRANSACTION_REQUIRED/);
  await repo.lockBudget('b', transaction, { shared: true });
  assert.match(calls[0][0], /pg_advisory_xact_lock_shared/);
  assert.equal(calls[1][1].lock, 'SHARE');
  const row = await repo.compareAndSwap(
    'b',
    '9007199254740993',
    { administrative_name: 'corrected' },
    transaction,
  );
  assert.equal(row.revision, '9007199254740994');
  assert.equal(calls.at(-1)[1].where.revision, '9007199254740993');
  count = 0;
  await assert.rejects(
    repo.compareAndSwap('b', '1', {}, transaction),
    (error) => error.code === 'revisionMismatch',
  );
  await assert.rejects(
    repo.compareAndSwap('b', '1', { created_by: 'other' }, transaction),
    /IMMUTABLE/,
  );
  await repo.referencesObject('o', transaction);
  assert.match(
    calls.at(-1)[0],
    /pending_object_id=:objectId OR published_object_id=:objectId/,
  );
  for (const [, options] of calls)
    assert.equal(options.transaction, transaction);
});

test('T013 object repository fences leases, orders locks, claims with SKIP LOCKED after budget lock and excludes references', async () => {
  const calls = [];
  const model = {
    sequelize: {
      query: async (sql, options) => {
        calls.push([sql, options]);
        if (sql.includes('SELECT id,owner_budget_id'))
          return [{ id: 'o', owner_budget_id: 'b' }];
        if (sql.includes('AS acquired')) return [{ acquired: true }];
        if (sql.includes('FOR UPDATE SKIP LOCKED')) return [{ id: 'o' }];
        if (sql.includes('RETURNING')) return [{ id: 'o' }];
        return [];
      },
    },
    findByPk: async (id, options) => {
      calls.push([id, options]);
      return { id };
    },
  };
  const repo = new BudgetPdfObjectRepositoryClient(model);
  await repo.lockObjects(['z', 'a', 'z'], transaction);
  assert.deepEqual(
    calls.slice(0, 2).map((call) => call[0]),
    ['a', 'z'],
  );
  await repo.compareAndSwapLease(
    {
      id: 'o',
      token: 'token',
      state: 'UPLOADING',
      nextState: 'READY',
      values: { size_bytes: '381' },
    },
    transaction,
  );
  assert.match(
    calls.at(-1)[0],
    /lease_token=:token AND state=:state AND lease_until>CURRENT_TIMESTAMP/,
  );
  assert.equal(calls.at(-1)[1].replacements.token, 'token');
  calls.length = 0;
  assert.equal((await repo.claimCleanup(transaction)).length, 1);
  const sql = calls.map((call) => call[0]).join('\n');
  assert.ok(
    sql.indexOf('pg_try_advisory_xact_lock') <
      sql.indexOf('FOR UPDATE SKIP LOCKED'),
  );
  assert.match(sql, /pending_object_id=:id OR published_object_id=:id/);
  assert.match(sql, /attempts=attempts\+1/);
  for (const [, options] of calls)
    assert.equal(options.transaction, transaction);
});

test('T013 authorization repository orders guards, locks current users/membership and never reads OS/stock grants', async () => {
  const calls = [];
  const manager = {
    sequelize: {
      query: async (sql, options) => {
        calls.push([sql, options]);
        if (sql.includes('FROM public.users'))
          return [
            {
              id: options.replacements.id,
              role: 'user',
              status_users: 'active',
            },
          ];
        if (sql.includes('user_sectors') || sql.includes('commercial_managers'))
          return [{ user_id: options.replacements.id }];
        if (sql.includes('commercial_permissions'))
          return [{ operation: 'READ' }];
        return [];
      },
    },
  };
  const repo = new BudgetCommercialAuthorizationRepositoryClient({ manager });
  await repo.lockAuthorizationGuards(['z:s', 'a:s', 'a:s'], transaction);
  assert.deepEqual(
    calls.map((call) => call[1].replacements.key),
    ['budget-auth:a:s', 'budget-auth:z:s'],
  );
  const result = await repo.readAuthorizationSnapshot(
    { actorId: 'z', targetUserId: 'a', sectorId: 's' },
    transaction,
  );
  assert.deepEqual(result.operations, ['READ']);
  assert.equal(result.isMember, true);
  const sql = calls.map((call) => call[0]).join('\n');
  assert.match(sql, /user_sectors.*FOR SHARE/);
  assert.doesNotMatch(sql, /service_order|inventory|material/);
  for (const [, options] of calls)
    assert.equal(options.transaction, transaction);
});
