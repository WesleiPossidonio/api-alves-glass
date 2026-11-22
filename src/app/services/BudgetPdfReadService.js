import budgets from '../repositories/BudgetPdfRepository.js';
import objects from '../repositories/BudgetPdfObjectRepository.js';
import authRepository from '../repositories/BudgetCommercialAuthorizationRepository.js';
import { createBudgetAuthorizationService } from './BudgetAuthorizationService.js';
import { requireBudgetUser } from './BudgetPdfCreateService.js';
import {
  budgetError,
  commercialNumber,
  createBudgetCursorService,
  expired,
  listLimit,
  strictInput,
  uuid,
} from './BudgetContractService.js';

const timestamp = (value) =>
  value == null ? null : new Date(value).toISOString();
export function internalBudgetDto(row, now = new Date()) {
  return {
    id: row.id,
    sectorId: row.sector_id,
    clientId: row.client_id,
    commercialNumber: row.commercial_number,
    administrativeName: row.administrative_name,
    createdBy: row.created_by,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    revision: String(row.revision),
    firstPublishedAt: timestamp(row.first_published_at),
    published: row.published_object_id
      ? {
          documentId: row.published_object_id,
          validityDate: row.published_validity_date,
          expired: expired(row.published_validity_date, now),
        }
      : null,
    pending: row.pending_object_id
      ? {
          documentId: row.pending_object_id,
          validityDate: row.pending_validity_date,
        }
      : null,
  };
}
export class BudgetPdfReadService {
  constructor({
    budgets: budgetRepository = budgets,
    objects: objectRepository = objects,
    authorization = createBudgetAuthorizationService({
      repository: authRepository,
    }),
    cursors,
    cursorSecret,
    now = () => new Date(),
  } = {}) {
    this.budgets = budgetRepository;
    this.objects = objectRepository;
    this.authorization = authorization;
    this.cursors = cursors;
    this.cursorSecret = cursorSecret;
    this.now = now;
  }
  cursorService() {
    // Explicit injected secret, no random per-process fallback or hidden reuse
    // of session/MinIO credentials. Transport composition is T027/T028.
    return (this.cursors ??= createBudgetCursorService({
      secret: this.cursorSecret,
    }));
  }
  async authorize(actorId, sectorId, transaction) {
    try {
      await this.authorization.authorizeOperation(
        { actorId, sectorId, operation: 'READ' },
        transaction,
      );
    } catch (error) {
      if (error.code === 'forbidden') throw budgetError('notFound');
      throw error;
    }
  }
  async list(input, actor) {
    const actorId = requireBudgetUser(actor);
    strictInput(
      input,
      ['sectorId', 'clientId', 'commercialNumber', 'limit', 'cursor'],
      ['sectorId'],
    );
    const sectorId = uuid(input.sectorId),
      limit = listLimit(input.limit);
    const filters = {
      ...(Object.hasOwn(input, 'clientId')
        ? { clientId: uuid(input.clientId) }
        : {}),
      ...(Object.hasOwn(input, 'commercialNumber')
        ? { commercialNumber: commercialNumber(input.commercialNumber) }
        : {}),
    };
    const context = { actor: actorId, scope: `internal:${sectorId}`, filters };
    try {
      return await this.objects.transaction(async (transaction) => {
        await this.authorize(actorId, sectorId, transaction);
        const cursors = this.cursorService();
        const position = Object.hasOwn(input, 'cursor')
          ? cursors.read(input.cursor, context)
          : undefined;
        const rows = await this.budgets.listInternal(
          { sectorId, ...filters, limit, position },
          transaction,
        );
        const page = rows.slice(0, limit),
          last = page.at(-1),
          now = this.now();
        return {
          items: page.map((row) => internalBudgetDto(row, now)),
          nextCursor:
            rows.length > limit
              ? cursors.issue(context, {
                  id: last.id,
                  createdAt: last.cursor_created_at,
                })
              : null,
        };
      });
    } catch (error) {
      throw budgetError(error.code ?? 'storageUnavailable');
    }
  }
  async detail(id, actor) {
    const actorId = requireBudgetUser(actor);
    uuid(id);
    try {
      return await this.objects.transaction(async (transaction) => {
        const discovered = await this.budgets.findById(id, transaction);
        if (!discovered) throw budgetError('notFound');
        await this.authorize(actorId, discovered.sector_id, transaction);
        const current = await this.budgets.lockBudget(id, transaction, {
          shared: true,
        });
        // Do not acquire another sector auth guard after owner lock. If a
        // concurrent future edit moved scope, fail closed without revealing it.
        if (!current || current.sector_id !== discovered.sector_id)
          throw budgetError('notFound');
        return internalBudgetDto(current, this.now());
      });
    } catch (error) {
      throw budgetError(error.code ?? 'storageUnavailable');
    }
  }
}
export default new BudgetPdfReadService();
