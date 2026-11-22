import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  matrixFixture,
  waitForLock,
} from '../../support/budgets/matrix-fixture.js';
import { BUDGET_OPERATIONS } from '../../../src/app/services/BudgetAuthorizationService.js';

test('T022 commercial authorization matrix on real PG17', async (t) => {
  const f = await matrixFixture();
  const { rows, tx, authorization: auth, authRepository: repo } = f;
  const admin = f.creator,
    manager = await f.user(),
    delegate = await f.user(),
    reader = await f.user(),
    outside = await f.sector();
  const sector = f.sectorId;
  async function member(user) {
    await rows(
      'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:user,:sector,:admin,now())',
      { user, sector, admin },
    );
  }
  async function operation(actor, operation, scope = sector, budget) {
    return tx((transaction) =>
      auth.authorizeOperation(
        { actorId: actor, sectorId: scope, operation, budget },
        transaction,
      ),
    );
  }
  async function change(actor, target, action, operation, transaction) {
    const input = {
      actorId: actor,
      targetUserId: target,
      sectorId: sector,
      action,
      operation,
    };
    const work = async (transaction) => {
      await auth.authorizePermissionChange(input, transaction);
      if (action === 'APPOINT_MANAGER')
        await repo.appoint(
          { user_id: target, sector_id: sector, appointed_by: actor },
          transaction,
        );
      if (action === 'REVOKE_MANAGER')
        await repo.revokeManager(target, sector, transaction);
      if (action === 'GRANT')
        await repo.grant(
          { user_id: target, sector_id: sector, operation, granted_by: actor },
          transaction,
        );
      if (action === 'REVOKE')
        await repo.revoke(target, sector, operation, transaction);
      await repo.appendAudit(
        {
          id: randomUUID(),
          actor_user_id: actor,
          target_user_id: target,
          sector_id: sector,
          action,
          operation: operation ?? null,
        },
        transaction,
      );
    };
    return transaction ? work(transaction) : tx(work);
  }
  try {
    for (const id of [manager, delegate, reader]) await member(id);
    await t.test(
      'global admin, sector manager and immediate revocation',
      async () => {
        for (const op of BUDGET_OPERATIONS) await operation(admin, op, outside);
        await change(admin, manager, 'APPOINT_MANAGER');
        for (const op of BUDGET_OPERATIONS) {
          await operation(manager, op);
          await assert.rejects(operation(manager, op, outside), {
            code: 'forbidden',
          });
        }
        await change(admin, manager, 'REVOKE_MANAGER');
        for (const op of BUDGET_OPERATIONS)
          await assert.rejects(operation(manager, op), { code: 'forbidden' });
        await change(admin, manager, 'APPOINT_MANAGER');
      },
    );
    await t.test(
      'five delegated grants independent, READ not creator-scoped, all changes audited',
      async () => {
        for (const granted of BUDGET_OPERATIONS.filter(
          (op) => op !== 'MANAGE_PERMISSIONS',
        )) {
          await change(manager, delegate, 'GRANT', granted);
          for (const op of BUDGET_OPERATIONS) {
            if (op === granted) await operation(delegate, op);
            else
              await assert.rejects(operation(delegate, op), {
                code: 'forbidden',
              });
          }
          if (granted === 'READ') {
            const item = await f.attached();
            const budget = await f.Budget.findByPk(item.proof.owner_budget_id);
            assert.notEqual(budget.created_by, delegate);
            await operation(delegate, 'READ', sector, {
              sectorId: budget.sector_id,
              createdBy: budget.created_by,
            });
          }
          await change(manager, delegate, 'REVOKE', granted);
          await assert.rejects(operation(delegate, granted), {
            code: 'forbidden',
          });
        }
        const [audit] = await rows(
          'SELECT count(*) AS n FROM public.budget_commercial_permission_audit WHERE target_user_id=:delegate',
          { delegate },
        );
        assert.equal(Number(audit.n), 10);
      },
    );
    await t.test(
      'MANAGE_PERMISSIONS admin-only grant/revoke; self grant/appointment/elevation prohibited',
      async () => {
        await assert.rejects(
          change(manager, delegate, 'GRANT', 'MANAGE_PERMISSIONS'),
          { code: 'forbidden' },
        );
        await change(admin, delegate, 'GRANT', 'MANAGE_PERMISSIONS');
        await change(delegate, reader, 'GRANT', 'READ');
        await assert.rejects(operation(delegate, 'READ'), {
          code: 'forbidden',
        });
        for (const actor of [admin, manager, delegate]) {
          await assert.rejects(change(actor, actor, 'GRANT', 'READ'), {
            code: 'selfGrantForbidden',
          });
          await assert.rejects(change(actor, actor, 'APPOINT_MANAGER'), {
            code: 'selfGrantForbidden',
          });
        }
        await assert.rejects(change(delegate, reader, 'APPOINT_MANAGER'), {
          code: 'forbidden',
        });
        await assert.rejects(
          change(manager, delegate, 'REVOKE', 'MANAGE_PERMISSIONS'),
          { code: 'forbidden' },
        );
        await change(admin, delegate, 'REVOKE', 'MANAGE_PERMISSIONS');
        await assert.rejects(change(delegate, reader, 'REVOKE', 'READ'), {
          code: 'forbidden',
        });
        await change(admin, reader, 'REVOKE', 'READ');
      },
    );
    await t.test(
      'active membership required; published client ownership and pending isolation',
      async () => {
        await change(admin, reader, 'GRANT', 'READ');
        await rows(
          "UPDATE public.users SET status_users='inactive' WHERE id=:reader",
          { reader },
        );
        await assert.rejects(operation(reader, 'READ'), { code: 'forbidden' });
        await rows(
          "UPDATE public.users SET status_users='active' WHERE id=:reader",
          { reader },
        );
        await rows(
          'DELETE FROM public.user_sectors WHERE user_id=:reader AND sector_id=:sector',
          { reader, sector },
        );
        await assert.rejects(operation(reader, 'READ'), { code: 'forbidden' });
        await member(reader);
        await assert.rejects(
          operation(reader, 'READ', sector, { sectorId: outside }),
          { code: 'forbidden' },
        );
        const item = await f.attached();
        await tx((transaction) =>
          f.budgets.compareAndSwap(
            item.proof.owner_budget_id,
            '1',
            {
              published_object_id: item.proof.id,
              published_validity_date: item.date,
              pending_object_id: null,
              pending_validity_date: null,
              first_published_at: new Date(),
            },
            transaction,
          ),
        );
        const actual = await f.Budget.findByPk(item.proof.owner_budget_id),
          budget = {
            clientId: actual.client_id,
            publishedObjectId: actual.published_object_id,
          };
        await tx((transaction) =>
          auth.authorizeClientRead(
            { clientId: f.clientId, budget, slot: 'published' },
            transaction,
          ),
        );
        for (const input of [
          { clientId: await f.client(), slot: 'published' },
          { clientId: f.clientId, slot: 'pending' },
        ])
          await assert.rejects(
            tx((transaction) =>
              auth.authorizeClientRead({ ...input, budget }, transaction),
            ),
            { code: 'budgetNotFound' },
          );
      },
    );
    await t.test(
      'deterministic READ vs revoke: row/advisory lock waits, then new request denied',
      async () => {
        const reading = await f.db.transaction(),
          revoking = await f.db.transaction();
        try {
          await auth.authorizeOperation(
            { actorId: reader, sectorId: sector, operation: 'READ' },
            reading,
          );
          const [{ pid }] = await rows(
            'SELECT pg_backend_pid() AS pid',
            {},
            revoking,
          );
          const work = change(admin, reader, 'REVOKE', 'READ', revoking);
          await waitForLock(rows, pid);
          await reading.commit();
          await work;
          await revoking.commit();
          await assert.rejects(operation(reader, 'READ'), {
            code: 'forbidden',
          });
        } finally {
          if (!reading.finished) await reading.rollback();
          if (!revoking.finished) await revoking.rollback();
        }
      },
    );
    await t.test(
      'grant vs operation serializes; rollback grant never becomes authority',
      async () => {
        const granting = await f.db.transaction(),
          operating = await f.db.transaction();
        try {
          await change(admin, reader, 'GRANT', 'DELETE', granting);
          const [{ pid }] = await rows(
            'SELECT pg_backend_pid() AS pid',
            {},
            operating,
          );
          const work = auth.authorizeOperation(
            { actorId: reader, sectorId: sector, operation: 'DELETE' },
            operating,
          );
          work.catch(() => {});
          await waitForLock(rows, pid);
          await granting.rollback();
          await assert.rejects(work, { code: 'forbidden' });
          await operating.rollback();
          await assert.rejects(operation(reader, 'DELETE'), {
            code: 'forbidden',
          });
        } finally {
          if (!granting.finished) await granting.rollback();
          if (!operating.finished) await operating.rollback();
        }
      },
    );
  } finally {
    await f.db.close();
  }
});
