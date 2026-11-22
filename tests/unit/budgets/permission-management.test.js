import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('T053 management is transactional, idempotent, scoped and audited only on change', async () => {
  const { BudgetPermissionService } = await import(
    '../../../src/app/services/BudgetPermissionService.js'
  );
  const sector = randomUUID(),
    actor = randomUUID(),
    target = randomUUID();
  const state = { grants: new Set(), managers: new Set(), audits: [] };
  const calls = [];
  const repository = {
    async transaction(work) {
      const saved = {
        grants: new Set(state.grants),
        managers: new Set(state.managers),
        audits: [...state.audits],
      };
      try {
        return await work({});
      } catch (error) {
        Object.assign(state, saved);
        throw error;
      }
    },
    async appoint(row) {
      state.managers.add(row.user_id);
      return row;
    },
    async revokeManager(id) {
      return Number(state.managers.delete(id));
    },
    async grant(row) {
      state.grants.add(row.operation);
      return row;
    },
    async revoke(id, scope, op) {
      return Number(state.grants.delete(op));
    },
    async appendAudit(row) {
      state.audits.push(row);
      return row;
    },
  };
  const authorization = {
    async authorizePermissionChange(input, tx) {
      calls.push(input);
      assert.ok(tx);
      assert.equal(input.actorId, actor);
      assert.equal(input.targetUserId, target);
      assert.equal(input.sectorId, sector);
    },
    async authorizeOperation(input, tx) {
      assert.ok(tx);
      assert.equal(input.operation, 'MANAGE_PERMISSIONS');
    },
  };
  repository.readAuthorizationSnapshot = async () => ({
    target: {
      isManager: state.managers.has(target),
      operations: [...state.grants],
    },
  });
  const service = new BudgetPermissionService({
    repository,
    objects: repository,
    authorization,
  });
  const user = { id: actor, type: 'user' };
  assert.equal(
    (await service.change(sector, target, 'GRANT', 'READ', user)).changed,
    true,
  );
  assert.deepEqual(
    await service.change(sector, target, 'GRANT', 'READ', user),
    { changed: false, auditId: null },
  );
  assert.equal(
    (await service.change(sector, target, 'REVOKE', 'READ', user)).changed,
    true,
  );
  assert.deepEqual(
    await service.change(sector, target, 'REVOKE', 'READ', user),
    { changed: false, auditId: null },
  );
  assert.equal(state.audits.length, 2);
  assert.equal(
    (await service.change(sector, target, 'APPOINT_MANAGER', null, user))
      .changed,
    true,
  );
  assert.deepEqual(
    await service.change(sector, target, 'APPOINT_MANAGER', null, user),
    { changed: false, auditId: null },
  );
  assert.equal(
    (await service.change(sector, target, 'REVOKE_MANAGER', null, user))
      .changed,
    true,
  );
  assert.equal(state.audits.length, 4);
  for (const input of [
    [sector, actor, 'GRANT', 'READ', user],
    [sector, target, 'GRANT', 'UNKNOWN', user],
    [sector, target, 'APPOINT_MANAGER', 'READ', user],
  ])
    await assert.rejects(service.change(...input));
  assert.equal(state.audits.length, 4);
  assert.equal(calls.length, 8);
});
