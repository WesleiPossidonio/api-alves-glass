import budgets from '../repositories/BudgetPdfRepository.js';
import objects from '../repositories/BudgetPdfObjectRepository.js';
import authRepository from '../repositories/BudgetCommercialAuthorizationRepository.js';
import { createBudgetAuthorizationService } from './BudgetAuthorizationService.js';
import { requireBudgetUser } from './BudgetPdfCreateService.js';
import { mutationFailure } from './BudgetPdfEditService.js';
import {
  assertRevision,
  budgetError,
  expectedRevision,
  strictInput,
  uuid,
} from './BudgetContractService.js';

export class BudgetPdfDeleteService {
  constructor({
    budgets: budgetRepository = budgets,
    objects: objectRepository = objects,
    authorization = createBudgetAuthorizationService({
      repository: authRepository,
    }),
  } = {}) {
    this.budgets = budgetRepository;
    this.objects = objectRepository;
    this.authorization = authorization;
  }
  async delete(id, input, actor, { ifMatch } = {}) {
    const actorId = requireBudgetUser(actor);
    uuid(id);
    strictInput(input, ['confirmBudgetId'], ['confirmBudgetId']);
    if (uuid(input.confirmBudgetId) !== id) throw budgetError('validation');
    const revision = expectedRevision(ifMatch, id);
    try {
      return await this.objects.transaction(async (transaction) => {
        const discovered = await this.budgets.findById(id, transaction);
        if (!discovered) throw budgetError('notFound');
        const guard = {
          actorId,
          sectorId: discovered.sector_id,
          operation: 'DELETE',
        };
        await this.authorization.authorizeOperation(guard, transaction);
        const current = await this.budgets.lockBudget(id, transaction);
        if (!current) throw budgetError('notFound');
        if (current.sector_id !== discovered.sector_id)
          throw budgetError('revisionMismatch');
        assertRevision(revision, String(current.revision));
        // Includes detached objects and in-flight uploads, not just both slots.
        // Owner advisory lock serializes new intents, attach and cleanup.
        await this.objects.lockOwnerObjects(id, transaction);
        await this.authorization.authorizeOperation(guard, transaction);
        await this.budgets.remove(id, revision, transaction);
        // Deferred integrity checks observe deletion + enqueue as a single commit.
        // Registry survives permanently to reconcile remote late PUTs.
        await this.objects.enqueueOwnerCleanup(id, transaction);
        return { id, deleted: true, cleanupPending: true };
      });
    } catch (error) {
      throw mutationFailure(error);
    }
  }
}
export default new BudgetPdfDeleteService();
