import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const directory = new URL('../../../src/database/migrations/', import.meta.url);
export const migrationNames = [
  '20261127000000-create-budget-commercial-authorization.cjs',
  '20261128000000-create-budget-pdf-objects.cjs',
  '20261129000000-create-budgets-pdf.cjs',
];

function recordingInterface({
  populated = false,
  failDDL = false,
  prerequisite = true,
} = {}) {
  const calls = [];
  const transaction = {};
  let committed = false;
  const queryInterface = {
    sequelize: {
      transaction: async (callback) => {
        await callback(transaction);
        committed = true;
      },
      query: async (sql, options) => {
        assert.equal(options.transaction, transaction);
        calls.push(sql);
        if (sql.includes('SELECT name FROM public."SequelizeMeta"'))
          return [
            prerequisite ? [{ name: options.replacements.previous }] : [],
          ];
        if (sql.includes('AS populated')) return [[{ populated }]];
        if (failDDL && sql.includes('CREATE TABLE'))
          throw new Error('injected DDL failure');
        return [[]];
      },
    },
  };
  return { queryInterface, calls, committed: () => committed };
}

test('T008–T010 migrations exist strictly after the historical maximum', () => {
  const historical = readdirSync(directory)
    .filter((name) => name < migrationNames[0])
    .sort()
    .at(-1);
  assert.equal(
    historical,
    '20261126000000-add-service-order-informational-priority.cjs',
  );
  for (const name of migrationNames) {
    assert.ok(name > historical);
    assert.ok(existsSync(new URL(name, directory)), `${name} not implemented`);
  }
});

for (const [index, name] of migrationNames.entries()) {
  test(`T008–T010 ${name}: transactional additive DDL, no legacy DML, prerequisite and protected down`, async () => {
    assert.ok(existsSync(new URL(name, directory)), `${name} not implemented`);
    const migration = require(new URL(name, directory).pathname);
    const recording = recordingInterface();
    await migration.up(recording.queryInterface);
    const sql = recording.calls.join('\n');
    assert.ok(recording.committed());
    assert.match(sql, /public\."SequelizeMeta"/);
    assert.doesNotMatch(
      sql,
      /\b(?:INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|DROP TABLE)\s+public\.(?:budget\b|users\b|client\b|sectors\b|service_)/i,
    );
    assert.doesNotMatch(sql, /\b(?:sync|seed|CASCADE)\b/i);
    const missing = recordingInterface({ prerequisite: false });
    await assert.rejects(
      migration.up(missing.queryInterface),
      /BUDGET_MIGRATION_PREREQUISITE/,
    );
    assert.equal(missing.calls.length, 1);
    const failed = recordingInterface({ failDDL: true });
    await assert.rejects(
      migration.up(failed.queryInterface),
      /injected DDL failure/,
    );
    assert.equal(failed.committed(), false);
    const populated = recordingInterface({ populated: true });
    await assert.rejects(
      migration.down(populated.queryInterface),
      /BUDGET_ROLLBACK_REQUIRES_EMPTY_TABLES/,
    );
    assert.equal(
      populated.calls.some((call) => call.includes('DROP TABLE')),
      false,
    );
    const empty = recordingInterface();
    await migration.down(empty.queryInterface);
    assert.match(empty.calls.join('\n'), /LOCK TABLE .*ACCESS EXCLUSIVE MODE/s);
    assert.match(empty.calls.join('\n'), /DROP TABLE/);
    assert.doesNotMatch(empty.calls.join('\n'), /CASCADE/i);
    if (index === 0) {
      assert.match(sql, /PRIMARY KEY \(user_id, sector_id\)/);
      assert.match(sql, /PRIMARY KEY \(user_id, sector_id, operation\)/);
      for (const op of [
        'CREATE_EDIT',
        'READ',
        'REPLACE_PDF',
        'PUBLISH',
        'DELETE',
        'MANAGE_PERMISSIONS',
      ])
        assert.ok(sql.includes(`'${op}'`));
      for (const action of [
        'APPOINT_MANAGER',
        'REVOKE_MANAGER',
        'GRANT',
        'REVOKE',
      ])
        assert.ok(sql.includes(`'${action}'`));
      assert.match(sql, /BEFORE UPDATE OR DELETE/);
      assert.match(sql, /BEFORE TRUNCATE/);
      assert.match(sql, /ON DELETE RESTRICT ON UPDATE RESTRICT/);
    } else if (index === 1) {
      assert.match(sql, /owner_budget_id uuid NOT NULL/);
      assert.doesNotMatch(sql, /owner_budget_id[^\n]*REFERENCES/);
      assert.match(sql, /UNIQUE \(id, owner_budget_id\)/);
      assert.match(sql, /UNIQUE \(bucket, object_key\)/);
      assert.match(sql, /10485760/);
      assert.match(sql, /size_bytes IS NOT NULL/);
      assert.match(sql, /sha256 IS NOT NULL/);
      assert.match(sql, /lease_token IS NOT NULL AND lease_until IS NOT NULL/);
      for (const state of [
        'UPLOADING',
        'READY',
        'ATTACHED',
        'CLEANUP_PENDING',
        'CLEANING',
        'REMOVED',
      ])
        assert.ok(sql.includes(`'${state}'`));
      assert.match(sql, /state, next_attempt_at, id/);
    } else {
      assert.match(sql, /commercial_number varchar\(64\) COLLATE "C" NOT NULL/);
      assert.match(sql, /revision bigint NOT NULL DEFAULT 1/);
      assert.match(sql, /FOREIGN KEY \(pending_object_id, id\)/);
      assert.match(sql, /FOREIGN KEY \(published_object_id, id\)/);
      assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
      assert.match(
        sql,
        /first_published_at IS DISTINCT FROM OLD.first_published_at/,
      );
      assert.match(
        sql,
        /pending_object_id IS NULL OR published_object_id IS NULL OR pending_object_id <> published_object_id/,
      );
      assert.match(sql, /sector_id, created_at DESC, id DESC/);
      assert.match(sql, /client_id, created_at DESC, id DESC/);
      assert.doesNotMatch(sql, /description_budget|total_value|deleted_at/);
    }
  });
}
