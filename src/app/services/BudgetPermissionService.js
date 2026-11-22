import { randomUUID } from 'node:crypto';
import repository from '../repositories/BudgetCommercialAuthorizationRepository.js';
import objects from '../repositories/BudgetPdfObjectRepository.js';
import {
  createBudgetAuthorizationService,
  BUDGET_OPERATIONS,
  BudgetAuthorizationError,
} from './BudgetAuthorizationService.js';
import { requireBudgetUser } from './BudgetPdfCreateService.js';
import { budgetError, uuid } from './BudgetContractService.js';
import { mutationFailure } from './BudgetPdfEditService.js';

const actions = ['GRANT', 'REVOKE', 'APPOINT_MANAGER', 'REVOKE_MANAGER'];

export class BudgetPermissionService {
  constructor({
    repository: repo = repository,
    objects: registry = objects,
    authorization = createBudgetAuthorizationService({ repository: repo }),
  } = {}) {
    this.repository = repo;
    this.objects = registry;
    this.authorization = authorization;
  }
  async list(sectorId, actor) {
    const actorId = requireBudgetUser(actor);
    uuid(sectorId);
    try {
      return await this.objects.transaction(async (tx) => {
        await this.authorization.authorizeOperation(
          { actorId, sectorId, operation: 'MANAGE_PERMISSIONS' },
          tx,
        );
        // The same authorization guard serializes revocations against this read.
        return {
          managers: await this.repository.listManagers(sectorId, tx),
          permissions: await this.repository.listGrants(sectorId, tx),
        };
      });
    } catch (error) {
      throw mutationFailure(error);
    }
  }
  async change(sectorId, targetUserId, action, operation, actor) {
    const actorId = requireBudgetUser(actor);
    uuid(sectorId);
    uuid(targetUserId);
    const manager = action === 'APPOINT_MANAGER' || action === 'REVOKE_MANAGER';
    if (
      !actions.includes(action) ||
      (manager ? operation != null : !BUDGET_OPERATIONS.includes(operation))
    )
      throw budgetError('validation');
    try {
      return await this.objects.transaction(async (tx) => {
        await this.authorization.authorizePermissionChange(
          {
            actorId,
            targetUserId,
            sectorId,
            action,
            operation: manager ? null : operation,
          },
          tx,
        );
        // Authorization locks both identities in sorted order. Never use a cached
        // grant or a caller-supplied role/membership to decide whether to write.
        const current = await this.repository.readAuthorizationSnapshot(
          { actorId, targetUserId, sectorId },
          tx,
        );
        const exists = manager
          ? current.target.isManager
          : current.target.operations.includes(operation);
        if (exists === ['GRANT', 'APPOINT_MANAGER'].includes(action))
          return { changed: false, auditId: null };
        if (action === 'APPOINT_MANAGER')
          await this.repository.appoint(
            {
              user_id: targetUserId,
              sector_id: sectorId,
              appointed_by: actorId,
            },
            tx,
          );
        if (action === 'REVOKE_MANAGER')
          await this.repository.revokeManager(targetUserId, sectorId, tx);
        if (action === 'GRANT')
          await this.repository.grant(
            {
              user_id: targetUserId,
              sector_id: sectorId,
              operation,
              granted_by: actorId,
            },
            tx,
          );
        if (action === 'REVOKE')
          await this.repository.revoke(targetUserId, sectorId, operation, tx);
        const auditId = randomUUID();
        await this.repository.appendAudit(
          {
            id: auditId,
            actor_user_id: actorId,
            target_user_id: targetUserId,
            sector_id: sectorId,
            action,
            operation: manager ? null : operation,
          },
          tx,
        );
        return { changed: true, auditId };
      });
    } catch (error) {
      if (error instanceof BudgetAuthorizationError) throw error;
      throw mutationFailure(error);
    }
  }
}
export default new BudgetPermissionService();
