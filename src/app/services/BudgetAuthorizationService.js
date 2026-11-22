export const BUDGET_OPERATIONS = Object.freeze([
  'CREATE_EDIT',
  'READ',
  'REPLACE_PDF',
  'PUBLISH',
  'DELETE',
  'MANAGE_PERMISSIONS',
]);

export class BudgetAuthorizationError extends Error {
  constructor(code = 'forbidden') {
    super(code);
    this.code = code;
    this.status = code === 'budgetNotFound' ? 404 : 403;
  }
}

const deny = (code) => {
  throw new BudgetAuthorizationError(code);
};
const active = (actor) => actor?.status_users === 'active';

export function createBudgetAuthorizationService({ repository }) {
  async function snapshot(
    { actorId, sectorId, targetUserId, operation },
    transaction,
  ) {
    if (!transaction || !actorId || !sectorId) deny();
    const keys = [
      ...new Set(
        [actorId, targetUserId]
          .filter(Boolean)
          .map((id) => `${id}:${sectorId}`),
      ),
    ].sort();
    await repository.lockAuthorizationGuards(keys, transaction, {
      shared: operation === 'READ' && !targetUserId,
    });
    const current = await repository.readAuthorizationSnapshot(
      { actorId, sectorId, targetUserId },
      transaction,
    );
    if (current.actor?.id !== actorId || !active(current.actor)) deny();
    return current;
  }
  const permitted = (current, operation) =>
    current.actor.role === 'admin' ||
    (current.actor.role === 'user' &&
      current.isMember &&
      (current.isManager || current.operations.includes(operation)));

  return {
    async authorizeOperations(inputs, transaction) {
      if (!transaction || !Array.isArray(inputs) || inputs.length === 0) deny();
      for (const input of inputs) {
        if (
          !input.actorId ||
          !input.sectorId ||
          !BUDGET_OPERATIONS.includes(input.operation)
        )
          deny();
      }
      const keys = [
        ...new Set(inputs.map((input) => `${input.actorId}:${input.sectorId}`)),
      ].sort();
      // Cross-sector edits acquire the entire set before any row lock or read.
      await repository.lockAuthorizationGuards(keys, transaction);
      for (const input of [...inputs].sort((a, b) =>
        `${a.actorId}:${a.sectorId}`.localeCompare(
          `${b.actorId}:${b.sectorId}`,
        ),
      )) {
        await this.authorizeOperation(input, transaction);
      }
      return true;
    },
    async authorizeOperation(input, transaction) {
      if (!BUDGET_OPERATIONS.includes(input.operation)) deny();
      const current = await snapshot(input, transaction);
      if (input.budget && input.budget.sectorId !== input.sectorId) deny();
      if (!permitted(current, input.operation)) deny();
      return true;
    },
    async authorizeClientRead({ clientId, budget, slot }, transaction) {
      if (
        !transaction ||
        !clientId ||
        !budget ||
        budget.clientId !== clientId ||
        slot !== 'published' ||
        !budget.publishedObjectId
      )
        deny('budgetNotFound');
      // clientId must originate from requireClient, never a request body field.
      return true;
    },
    async authorizePermissionChange(input, transaction) {
      const { actorId, targetUserId, action, operation } = input;
      if (
        !targetUserId ||
        !['GRANT', 'REVOKE', 'APPOINT_MANAGER', 'REVOKE_MANAGER'].includes(
          action,
        )
      )
        deny();
      const appointment =
        action === 'APPOINT_MANAGER' || action === 'REVOKE_MANAGER';
      if (
        appointment ? operation != null : !BUDGET_OPERATIONS.includes(operation)
      )
        deny();
      const current = await snapshot(input, transaction);
      if (
        actorId === targetUserId &&
        ['GRANT', 'APPOINT_MANAGER'].includes(action)
      )
        deny('selfGrantForbidden');
      const target = current.target;
      if (
        !target ||
        target.id !== targetUserId ||
        !active(target) ||
        (target.role === 'user' && !target.isMember)
      )
        deny();
      if (current.actor.role === 'admin') return true;
      if (
        appointment ||
        operation === 'MANAGE_PERMISSIONS' ||
        target.role !== 'user' ||
        target.isManager ||
        !permitted(current, 'MANAGE_PERMISSIONS')
      )
        deny();
      return true;
    },
  };
}
