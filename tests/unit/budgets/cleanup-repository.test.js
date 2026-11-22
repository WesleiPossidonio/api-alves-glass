import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetPdfObjectRepositoryClient } from '../../../src/app/repositories/BudgetPdfObjectRepository.js';

test('T018 repository cleanup transaction bounds, global lock order and live DB lease CAS', async () => {
  const calls = [];
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const candidate = {
    id: '12345678-1234-4234-8234-123456789abc',
    owner_budget_id: '12345678-1234-4234-8234-123456789abc',
  };
  const model = {
    sequelize: {
      transaction: async (options, fn) => {
        assert.equal(options.isolationLevel, 'READ COMMITTED');
        return fn(transaction);
      },
      query: async (sql, options) => {
        assert.equal(options.transaction, transaction);
        calls.push(sql);
        return [{ id: candidate.id }];
      },
    },
    findByPk: async (_, options) => {
      assert.equal(options.lock, 'UPDATE');
      calls.push('object lock');
      return candidate;
    },
  };
  const repository = new BudgetPdfObjectRepositoryClient(model);
  await repository.transaction(async (tx) => {
    assert.equal(await repository.lockOwned(candidate, tx), candidate);
    assert.equal(await repository.leaseIsCurrent(candidate, 'token', tx), true);
  });
  assert.match(
    calls[0],
    /lock_timeout.*5s.*statement_timeout.*110s.*idle_in_transaction_session_timeout.*110s/,
  );
  assert.match(calls[1], /pg_advisory_xact_lock/);
  assert.match(calls[2], /budgets_pdf.*FOR UPDATE/);
  assert.equal(calls[3], 'object lock');
  assert.match(
    calls[4],
    /state='CLEANING'.*lease_token=:token.*lease_until>CURRENT_TIMESTAMP/,
  );
});
test('T018 reconciliation uses PostgreSQL time, bounded keyset, both reference slots, no deletion/purge', async () => {
  const calls = [];
  const repository = new BudgetPdfObjectRepositoryClient({
    sequelize: {
      query: async (sql, options) => {
        calls.push([sql, options.replacements]);
        return [];
      },
    },
  });
  const tx = {};
  await repository.reconcileCandidates(tx);
  await repository.reconcileCandidates(tx, {
    after: '12345678-1234-4234-8234-123456789abc',
  });
  await repository.enqueueUnreferenced({ id: 'id' }, tx);
  const sql = calls.map(([query]) => query).join('\n');
  assert.match(sql, /state='UPLOADING' AND lease_until<=CURRENT_TIMESTAMP/);
  assert.match(sql, /state='READY'.*interval '24 hours'/s);
  assert.match(sql, /id>CAST\(:after AS uuid\)/);
  assert.match(sql, /ORDER BY id LIMIT :limit/);
  assert.match(sql, /pending_object_id=:id OR published_object_id=:id/);
  assert.match(sql, /lease_token=NULL,lease_until=NULL,removed_at=NULL/);
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE|DROP|state='ATTACHED'/);
  await assert.rejects(
    repository.reconcileCandidates(tx, { limit: 26 }),
    /BUDGET_CLAIM_LIMIT/,
  );
});
test('T018 unknown objects register only after key and reference checks; no FK cascade', async () => {
  const calls = [];
  const tx = {};
  let referenced = true;
  const model = {
    sequelize: {
      query: async (sql) => {
        calls.push(sql);
        return sql.includes('pending_object_id') && referenced
          ? [{ id: 'budget' }]
          : [];
      },
    },
    create: async (values) => {
      calls.push('intent');
      assert.equal(values.state, 'UPLOADING');
      assert.equal(values.validity_date, '0001-01-01');
      return values;
    },
  };
  const repository = new BudgetPdfObjectRepositoryClient(model);
  const candidate = {
    id: 'id',
    bucket: 'private',
    object_key: 'key',
    owner_budget_id: 'owner',
  };
  assert.equal(
    await repository.registerUnknown(candidate, 'technical-user', tx),
    false,
  );
  assert.ok(!calls.includes('intent'));
  referenced = false;
  assert.equal(
    await repository.registerUnknown(candidate, 'technical-user', tx),
    true,
  );
  assert.match(
    calls.at(-1),
    /state='CLEANUP_PENDING',lease_token=NULL,lease_until=NULL/,
  );
});
