import { randomUUID } from 'node:crypto';
import budgets from '../repositories/BudgetPdfRepository.js';
import objects from '../repositories/BudgetPdfObjectRepository.js';
import authRepository from '../repositories/BudgetCommercialAuthorizationRepository.js';
import { createBudgetAuthorizationService } from './BudgetAuthorizationService.js';
import { BudgetPdfStorageServiceClient } from './BudgetPdfStorageService.js';
import {
  administrativeName,
  budgetError,
  civilDate,
  commercialNumber,
  strictInput,
  uuid,
} from './BudgetContractService.js';

// Actor is trusted transport/session context, never a field of input. No HTTP,
// session-cookie parsing, or implicit READ grant belongs in this use case.
export function requireBudgetUser(actor) {
  if (!actor?.id) throw budgetError('forbidden');
  uuid(actor.id);
  if (actor.type !== 'user') throw budgetError('forbidden');
  return actor.id;
}
function safeFailure(error) {
  if (
    error.original?.code === '23505' &&
    error.original.constraint === 'budgets_pdf_number_uq'
  )
    return budgetError('duplicateNumber');
  if (error.original?.code === '23503') return budgetError('validation');
  return budgetError(error.code ?? 'storageUnavailable');
}
export class BudgetPdfCreateService {
  constructor({
    budgets: budgetRepository = budgets,
    objects: objectRepository = objects,
    authorization = createBudgetAuthorizationService({
      repository: authRepository,
    }),
    storage,
    now = Date.now,
  } = {}) {
    this.budgets = budgetRepository;
    this.objects = objectRepository;
    this.authorization = authorization;
    this.storage =
      storage ??
      new BudgetPdfStorageServiceClient({ repository: objectRepository });
    this.now = now;
  }
  async create(input, actor, bytes, { signal } = {}) {
    const actorId = requireBudgetUser(actor);
    const fields = [
      'sectorId',
      'clientId',
      'commercialNumber',
      'administrativeName',
      'validityDate',
    ];
    strictInput(input, fields, fields);
    const values = {
      sectorId: uuid(input.sectorId),
      clientId: uuid(input.clientId),
      commercialNumber: commercialNumber(input.commercialNumber),
      administrativeName: administrativeName(input.administrativeName),
      validityDate: civilDate(input.validityDate),
    };
    if (!Buffer.isBuffer(bytes) || bytes.length === 0)
      throw budgetError('invalidPdf');
    const guard = {
      actorId,
      sectorId: values.sectorId,
      operation: 'CREATE_EDIT',
    };
    const authorize = async (transaction) => {
      await this.authorization.authorizeOperation(guard, transaction);
      await this.budgets.requireReferences(values, transaction);
    };
    const checkAbort = () => {
      if (signal?.aborted) throw budgetError('storageUnavailable');
    };
    let proof, token;
    try {
      checkAbort();
      await this.objects.transaction(authorize);
      // prepare invokes the accepted runtime/qpdf validator and creates an
      // immutable bytes proof; no registry or external PUT on invalid PDF.
      proof = await this.storage.prepare(bytes, randomUUID(), { signal });
      token = randomUUID();
      checkAbort();
      await this.objects.transaction(async (transaction) => {
        await authorize(transaction);
        await this.objects.createIntent(
          {
            ...proof,
            created_by: actorId,
            validity_date: values.validityDate,
            expected_revision: null,
            lease_token: token,
            lease_until: new Date(this.now() + 120000),
          },
          transaction,
        );
      });
      const confirmed = await this.storage.upload(proof, token, { signal }); // includes external stat/size confirmation
      checkAbort();
      await this.objects.transaction(async (transaction) => {
        // Authorization guards always precede owner/object guards. Revocation
        // or membership loss during qpdf/PUT is effective before attachment.
        await authorize(transaction);
        const owned = await this.objects.lockOwned(proof, transaction);
        if (
          !owned ||
          owned.owner_budget_id !== proof.owner_budget_id ||
          owned.bucket !== proof.bucket ||
          owned.object_key !== proof.object_key
        )
          throw budgetError('budgetLeaseLost');
        checkAbort();
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
        await this.budgets.create(
          {
            id: proof.owner_budget_id,
            sector_id: values.sectorId,
            client_id: values.clientId,
            commercial_number: values.commercialNumber,
            administrative_name: values.administrativeName,
            created_by: actorId,
            revision: '1',
            pending_object_id: proof.id,
            pending_validity_date: values.validityDate,
            published_object_id: null,
            published_validity_date: null,
            first_published_at: null,
          },
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
        checkAbort();
      });
      return {
        id: proof.owner_budget_id,
        revision: '1',
        pendingDocumentId: proof.id,
      };
    } catch (error) {
      if (proof && token) {
        try {
          await this.objects.transaction((transaction) =>
            this.objects.scheduleCleanup(proof, token, transaction),
          );
        } catch {
          /* Persisted expiring intent remains discoverable by reconciler. Never physical DELETE here. */
        }
      }
      throw safeFailure(error);
    }
  }
}
export default new BudgetPdfCreateService();
