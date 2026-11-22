// T005 executable contract implemented by T014.
// Seam: createBudgetAuthorizationService({ repository }) exposes
// authorizeOperation, authorizeClientRead and authorizePermissionChange.
// repository.lockAuthorizationGuards(keys, transaction) precedes every fresh
// readAuthorizationSnapshot({ actorId, sectorId, targetUserId }, transaction).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

const moduleUrl = new URL(
  '../../../src/app/services/BudgetAuthorizationService.js',
  import.meta.url,
);
const operations = [
  'CREATE_EDIT',
  'READ',
  'REPLACE_PDF',
  'PUBLISH',
  'DELETE',
  'MANAGE_PERMISSIONS',
];
const budget = {
  id: 'budget-1',
  sectorId: 'sector-1',
  clientId: 'client-1',
  createdBy: 'different-author',
  publishedObjectId: 'published-1',
};
const member = {
  actor: { id: 'user-1', role: 'user', status_users: 'active' },
  isMember: true,
  isManager: false,
  operations: [],
};
const code = (expected) => (error) => error.code === expected;

async function setup(snapshot = structuredClone(member)) {
  assert.ok(
    existsSync(moduleUrl),
    'T014_PENDING: commercial authorization is not implemented',
  );
  const { createBudgetAuthorizationService } = await import(moduleUrl.href);
  const transaction = {};
  const calls = [];
  const repository = {
    lockAuthorizationGuards: async (keys, tx) => {
      assert.equal(tx, transaction);
      assert.deepEqual(keys, [...new Set(keys)].sort());
      calls.push('lock');
    },
    readAuthorizationSnapshot: async (query, tx) => {
      assert.equal(tx, transaction);
      assert.ok(calls.includes('lock'), 'authority must be read after locks');
      calls.push('read');
      return structuredClone(snapshot);
    },
  };
  return {
    service: createBudgetAuthorizationService({ repository }),
    transaction,
    snapshot,
    calls,
  };
}

test('T005 admin globally bypasses grants but not inactive status or unknown operations', async () => {
  const context = await setup({
    ...structuredClone(member),
    actor: { id: 'admin', role: 'admin', status_users: 'active' },
    isMember: false,
  });
  for (const operation of operations)
    await context.service.authorizeOperation(
      { actorId: 'admin', sectorId: 'unrelated-sector', operation },
      context.transaction,
    );
  await assert.rejects(
    context.service.authorizeOperation(
      { actorId: 'admin', sectorId: 'sector-1', operation: 'UNKNOWN' },
      context.transaction,
    ),
    code('forbidden'),
  );
  context.snapshot.actor.status_users = 'inactive';
  await assert.rejects(
    context.service.authorizeOperation(
      { actorId: 'admin', sectorId: 'sector-1', operation: 'READ' },
      context.transaction,
    ),
    code('forbidden'),
  );
});

test('T005 named manager is sector-bound and membership loss invalidates privileges on the next call', async () => {
  const context = await setup({ ...structuredClone(member), isManager: true });
  for (const operation of operations)
    await context.service.authorizeOperation(
      { actorId: 'user-1', sectorId: 'sector-1', operation },
      context.transaction,
    );
  context.snapshot.isMember = false;
  await assert.rejects(
    context.service.authorizeOperation(
      { actorId: 'user-1', sectorId: 'sector-1', operation: 'READ' },
      context.transaction,
    ),
    code('forbidden'),
  );
  context.snapshot.isMember = true;
  context.snapshot.isManager = false; // repository returns the other sector's scope
  await assert.rejects(
    context.service.authorizeOperation(
      { actorId: 'user-1', sectorId: 'sector-2', operation: 'READ' },
      context.transaction,
    ),
    code('forbidden'),
  );
});

test('T005 each of six grants is independent; READ is not filtered by authorship', async () => {
  for (const granted of operations) {
    const context = await setup({
      ...structuredClone(member),
      operations: [granted],
    });
    for (const requested of operations) {
      const action = () =>
        context.service.authorizeOperation(
          {
            actorId: 'user-1',
            sectorId: 'sector-1',
            operation: requested,
            budget,
          },
          context.transaction,
        );
      if (requested === granted) await action();
      else await assert.rejects(action(), code('forbidden'));
    }
  }
});

test('T005 OS/stock grants, authorship, stale membership and inactive user never grant commercial access', async () => {
  for (const patch of [
    { serviceOrderOperations: operations, inventoryOperations: operations },
    { operations: ['READ'], isMember: false },
    {
      operations: ['READ'],
      actor: { id: 'user-1', role: 'user', status_users: 'blocked' },
    },
    { operations: [], authoredBudgetIds: [budget.id] },
  ]) {
    const context = await setup({ ...structuredClone(member), ...patch });
    await assert.rejects(
      context.service.authorizeOperation(
        { actorId: 'user-1', sectorId: 'sector-1', operation: 'READ', budget },
        context.transaction,
      ),
      code('forbidden'),
    );
  }
});

test('T005 portal can read only its own published slot; pending/foreign/private are indistinguishable', async () => {
  const context = await setup();
  await context.service.authorizeClientRead(
    { clientId: 'client-1', budget, slot: 'published' },
    context.transaction,
  );
  for (const input of [
    { clientId: 'client-2', budget, slot: 'published' },
    { clientId: 'client-1', budget, slot: 'pending' },
    {
      clientId: 'client-1',
      budget: { ...budget, publishedObjectId: null },
      slot: 'published',
    },
    { clientId: 'client-1', budget: null, slot: 'published' },
  ])
    await assert.rejects(
      context.service.authorizeClientRead(input, context.transaction),
      code('budgetNotFound'),
    );
});

test('T005 grants/appointments prohibit self escalation including admin; delegation cannot name managers or grant MANAGE_PERMISSIONS', async () => {
  for (const role of ['admin', 'user']) {
    const context = await setup({
      ...structuredClone(member),
      actor: { id: 'user-1', role, status_users: 'active' },
      isManager: true,
    });
    for (const action of ['GRANT', 'APPOINT_MANAGER'])
      await assert.rejects(
        context.service.authorizePermissionChange(
          {
            actorId: 'user-1',
            targetUserId: 'user-1',
            sectorId: 'sector-1',
            action,
            operation: action === 'GRANT' ? 'READ' : null,
          },
          context.transaction,
        ),
        code('selfGrantForbidden'),
      );
  }
  for (const manager of [true, false]) {
    const context = await setup({
      ...structuredClone(member),
      isManager: manager,
      operations: manager ? [] : ['MANAGE_PERMISSIONS'],
      target: {
        id: 'user-2',
        role: 'user',
        status_users: 'active',
        isMember: true,
        isManager: false,
      },
    });
    for (const operation of operations.slice(0, 5))
      await context.service.authorizePermissionChange(
        {
          actorId: 'user-1',
          targetUserId: 'user-2',
          sectorId: 'sector-1',
          action: 'GRANT',
          operation,
        },
        context.transaction,
      );
    for (const change of [
      { action: 'GRANT', operation: 'MANAGE_PERMISSIONS' },
      { action: 'APPOINT_MANAGER', operation: null },
    ])
      await assert.rejects(
        context.service.authorizePermissionChange(
          {
            actorId: 'user-1',
            targetUserId: 'user-2',
            sectorId: 'sector-1',
            ...change,
          },
          context.transaction,
        ),
        code('forbidden'),
      );
    context.snapshot.target.isMember = false;
    await assert.rejects(
      context.service.authorizePermissionChange(
        {
          actorId: 'user-1',
          targetUserId: 'user-2',
          sectorId: 'sector-1',
          action: 'GRANT',
          operation: 'READ',
        },
        context.transaction,
      ),
      code('forbidden'),
    );
  }
});

test('T005 non-admin cannot modify another manager/admin; revocation still requires authority', async () => {
  for (const target of [
    {
      id: 'user-2',
      role: 'admin',
      status_users: 'active',
      isMember: true,
      isManager: false,
    },
    {
      id: 'user-2',
      role: 'user',
      status_users: 'active',
      isMember: true,
      isManager: true,
    },
    {
      id: 'user-2',
      role: 'user',
      status_users: 'inactive',
      isMember: true,
      isManager: false,
    },
  ]) {
    const context = await setup({
      ...structuredClone(member),
      isManager: true,
      target,
    });
    await assert.rejects(
      context.service.authorizePermissionChange(
        {
          actorId: 'user-1',
          targetUserId: 'user-2',
          sectorId: 'sector-1',
          action: 'GRANT',
          operation: 'READ',
        },
        context.transaction,
      ),
      code('forbidden'),
    );
  }
  const context = await setup({
    ...structuredClone(member),
    target: {
      id: 'user-2',
      role: 'user',
      status_users: 'active',
      isMember: true,
    },
  });
  await assert.rejects(
    context.service.authorizePermissionChange(
      {
        actorId: 'user-1',
        targetUserId: 'user-2',
        sectorId: 'sector-1',
        action: 'REVOKE',
        operation: 'READ',
      },
      context.transaction,
    ),
    code('forbidden'),
  );
});

test('T014 admin may appoint/grant management to another active member, never to a nonmember', async () => {
  const context = await setup({
    ...structuredClone(member),
    actor: { id: 'admin', role: 'admin', status_users: 'active' },
    target: {
      id: 'user-2',
      role: 'user',
      status_users: 'active',
      isMember: true,
      isManager: false,
    },
  });
  for (const change of [
    { action: 'APPOINT_MANAGER', operation: null },
    { action: 'GRANT', operation: 'MANAGE_PERMISSIONS' },
  ]) {
    await context.service.authorizePermissionChange(
      {
        actorId: 'admin',
        targetUserId: 'user-2',
        sectorId: 'sector-1',
        ...change,
      },
      context.transaction,
    );
  }
  context.snapshot.target.isMember = false;
  await assert.rejects(
    context.service.authorizePermissionChange(
      {
        actorId: 'admin',
        targetUserId: 'user-2',
        sectorId: 'sector-1',
        action: 'APPOINT_MANAGER',
        operation: null,
      },
      context.transaction,
    ),
    code('forbidden'),
  );
});

test('T014 requires transaction/actor identity, rechecks authority and orders cross-sector guards', async () => {
  const context = await setup({
    ...structuredClone(member),
    operations: ['CREATE_EDIT'],
  });
  await assert.rejects(
    context.service.authorizeOperation({
      actorId: 'user-1',
      sectorId: 's',
      operation: 'READ',
    }),
    code('forbidden'),
  );
  await assert.rejects(
    context.service.authorizeOperation(
      { actorId: 'forged-actor', sectorId: 's', operation: 'READ' },
      context.transaction,
    ),
    code('forbidden'),
  );
  await context.service.authorizeOperations(
    ['sector-z', 'sector-a'].map((sectorId) => ({
      actorId: 'user-1',
      sectorId,
      operation: 'CREATE_EDIT',
    })),
    context.transaction,
  );
  context.snapshot.operations = [];
  await assert.rejects(
    context.service.authorizeOperation(
      { actorId: 'user-1', sectorId: 'sector-a', operation: 'CREATE_EDIT' },
      context.transaction,
    ),
    code('forbidden'),
  );
});
