import budgets from '../repositories/BudgetPdfRepository.js';
import objects from '../repositories/BudgetPdfObjectRepository.js';
import authRepository from '../repositories/BudgetCommercialAuthorizationRepository.js';
import { createBudgetAuthorizationService } from './BudgetAuthorizationService.js';
import { BudgetPdfStorageServiceClient } from './BudgetPdfStorageService.js';
import { requireBudgetUser } from './BudgetPdfCreateService.js';
import {
  assertRevision,
  budgetError,
  expectedRevision,
  strictInput,
  uuid,
} from './BudgetContractService.js';

export class BudgetPdfPublishService {
  constructor({
    budgets: budgetRepository = budgets,
    objects: objectRepository = objects,
    authorization = createBudgetAuthorizationService({
      repository: authRepository,
    }),
    storage,
    now = () => new Date(),
  } = {}) {
    this.budgets = budgetRepository;
    this.objects = objectRepository;
    this.authorization = authorization;
    this.storage =
      storage ??
      new BudgetPdfStorageServiceClient({ repository: objectRepository });
    this.now = now;
  }
  async publish(id, input, actor, { ifMatch, signal } = {}) {
    const actorId = requireBudgetUser(actor);
    uuid(id);
    strictInput(input, ['pendingDocumentId'], ['pendingDocumentId']);
    const pendingId = uuid(input.pendingDocumentId);
    const revision = expectedRevision(ifMatch, id);
    const checkAbort = () => {
      if (signal?.aborted) throw budgetError('storageUnavailable');
    };
    const inspect = async (transaction) => {
      checkAbort();
      const discovered = await this.budgets.findById(id, transaction);
      if (!discovered) throw budgetError('notFound');
      await this.authorization.authorizeOperation(
        { actorId, sectorId: discovered.sector_id, operation: 'PUBLISH' },
        transaction,
      );
      const current = await this.budgets.lockBudget(id, transaction);
      // Scope discovery never authorizes after the lock; no cross-sector lock inversion.
      if (!current || current.sector_id !== discovered.sector_id)
        throw budgetError('notFound');
      assertRevision(revision, String(current.revision));
      if (!current.pending_object_id) throw budgetError('noPendingPdf');
      if (current.pending_object_id !== pendingId)
        throw budgetError('revisionMismatch');
      const locked = await this.objects.lockObjects(
        [pendingId, current.published_object_id].filter(Boolean),
        transaction,
      );
      const candidate = locked.find((row) => row?.id === pendingId);
      if (
        !candidate ||
        candidate.owner_budget_id !== id ||
        candidate.state !== 'ATTACHED' ||
        candidate.lease_token != null ||
        candidate.lease_until != null ||
        !candidate.confirmed_at ||
        !/^[a-f0-9]{64}$/.test(candidate.sha256) ||
        candidate.content_type !== 'application/pdf' ||
        !Number.isSafeInteger(Number(candidate.size_bytes)) ||
        Number(candidate.size_bytes) < 1 ||
        Number(candidate.size_bytes) > 10485760
      )
        throw budgetError('storageUnavailable');
      return { current, candidate };
    };
    try {
      // No network I/O in the main write transaction. Slot/revision and all
      // authority are reacquired after stat; cleanup cannot remove ATTACHED.
      const proof = await this.objects.transaction(inspect);
      const stat = await this.storage.stat(proof.candidate, { signal });
      if (!stat || Number(stat.size) !== Number(proof.candidate.size_bytes))
        throw budgetError('storageUnavailable');
      checkAbort();
      return await this.objects.transaction(async (transaction) => {
        const { current, candidate } = await inspect(transaction);
        if (
          candidate.bucket !== proof.candidate.bucket ||
          candidate.object_key !== proof.candidate.object_key ||
          String(candidate.size_bytes) !== String(proof.candidate.size_bytes) ||
          candidate.sha256 !== proof.candidate.sha256
        )
          throw budgetError('storageUnavailable');
        const previous = current.published_object_id;
        const updated = await this.budgets.compareAndSwap(
          id,
          revision,
          {
            published_object_id: pendingId,
            published_validity_date: current.pending_validity_date,
            pending_object_id: null,
            pending_validity_date: null,
            first_published_at: current.first_published_at ?? this.now(),
          },
          transaction,
        );
        if (previous)
          await this.objects.enqueueDetached(previous, id, transaction);
        checkAbort();
        return { id, revision: String(updated.revision) };
      });
    } catch (error) {
      const code =
        error.original?.code === '55P03' ? 'operationBusy' : error.code;
      throw budgetError(code ?? 'storageUnavailable');
    }
  }
}
export default new BudgetPdfPublishService();
