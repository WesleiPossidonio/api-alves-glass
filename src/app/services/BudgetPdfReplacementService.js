import { randomUUID } from 'node:crypto';
import {
  BudgetPdfCreateService,
  requireBudgetUser,
} from './BudgetPdfCreateService.js';
import { mutationFailure } from './BudgetPdfEditService.js';
import {
  assertRevision,
  budgetError,
  civilDate,
  expectedRevision,
  strictInput,
  uuid,
} from './BudgetContractService.js';

export class BudgetPdfReplacementService extends BudgetPdfCreateService {
  async replace(id, input, actor, bytes, { ifMatch, signal } = {}) {
    const actorId = requireBudgetUser(actor);
    uuid(id);
    strictInput(input, ['validityDate']);
    const revision = expectedRevision(ifMatch, id);
    const requested = Object.hasOwn(input, 'validityDate')
      ? civilDate(input.validityDate)
      : undefined;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0)
      throw budgetError('invalidPdf');
    const checkAbort = () => {
      if (signal?.aborted) throw budgetError('storageUnavailable');
    };
    const inspect = async (transaction) => {
      checkAbort();
      const discovered = await this.budgets.findById(id, transaction);
      if (!discovered) throw budgetError('notFound');
      const guard = {
        actorId,
        sectorId: discovered.sector_id,
        operation: 'REPLACE_PDF',
      };
      await this.authorization.authorizeOperation(guard, transaction);
      const current = await this.budgets.lockBudget(id, transaction);
      if (!current || current.sector_id !== discovered.sector_id)
        throw budgetError('revisionMismatch');
      assertRevision(revision, String(current.revision));
      const inherited =
        current.pending_validity_date ?? current.published_validity_date;
      if (requested !== undefined && requested !== inherited)
        await this.authorization.authorizeOperation(
          { ...guard, operation: 'CREATE_EDIT' },
          transaction,
        );
      return { current, validity: requested ?? inherited };
    };
    let proof, token;
    try {
      await this.objects.transaction(inspect);
      proof = await this.storage.prepare(bytes, id, { signal });
      token = randomUUID();
      await this.objects.transaction(async (transaction) => {
        const { validity } = await inspect(transaction);
        await this.objects.createIntent(
          {
            ...proof,
            created_by: actorId,
            validity_date: validity,
            expected_revision: revision,
            lease_token: token,
            lease_until: new Date(this.now() + 120000),
          },
          transaction,
        );
      });
      const confirmed = await this.storage.upload(proof, token, { signal });
      return await this.objects.transaction(async (transaction) => {
        const { current, validity } = await inspect(transaction);
        const previous = current.pending_object_id;
        const locked = await this.objects.lockObjects(
          [proof.id, previous].filter(Boolean),
          transaction,
        );
        const owned = locked.find((row) => row?.id === proof.id);
        if (
          !owned ||
          owned.owner_budget_id !== id ||
          owned.bucket !== proof.bucket ||
          owned.object_key !== proof.object_key ||
          String(owned.expected_revision) !== revision ||
          owned.validity_date !== validity
        )
          throw budgetError('budgetLeaseLost');
        await this.objects.compareAndSwapLease(
          {
            id: proof.id,
            token,
            state: 'UPLOADING',
            nextState: 'READY',
            values: { ...confirmed, confirmed_at: new Date(this.now()) },
          },
          transaction,
        );
        const updated = await this.budgets.compareAndSwap(
          id,
          revision,
          { pending_object_id: proof.id, pending_validity_date: validity },
          transaction,
        );
        await this.objects.compareAndSwapLease(
          {
            id: proof.id,
            token,
            state: 'READY',
            nextState: 'ATTACHED',
            values: { lease_token: null, lease_until: null },
          },
          transaction,
        );
        if (previous)
          await this.objects.enqueueDetached(previous, id, transaction);
        checkAbort();
        return {
          id,
          revision: String(updated.revision),
          pendingDocumentId: proof.id,
        };
      });
    } catch (error) {
      if (proof && token) {
        try {
          await this.objects.transaction((transaction) =>
            this.objects.scheduleCleanup(proof, token, transaction),
          );
        } catch {
          /* Durable intent remains recoverable; never delete physical bytes here. */
        }
      }
      throw mutationFailure(error);
    }
  }
}
export default new BudgetPdfReplacementService();
