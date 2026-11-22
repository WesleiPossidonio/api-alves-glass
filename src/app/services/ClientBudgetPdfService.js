import budgets from '../repositories/BudgetPdfRepository.js';
import objects from '../repositories/BudgetPdfObjectRepository.js';
import authRepository from '../repositories/BudgetCommercialAuthorizationRepository.js';
import { createBudgetAuthorizationService } from './BudgetAuthorizationService.js';
import {
  budgetError,
  createBudgetCursorService,
  expired,
  listLimit,
  strictInput,
  uuid,
} from './BudgetContractService.js';

export function requireBudgetClient(actor) {
  if (!actor?.id || actor.type !== 'client') throw budgetError('forbidden');
  return uuid(actor.id);
}
export function clientBudgetDto(row, now = new Date()) {
  return {
    id: row.id,
    administrativeName: row.administrative_name,
    commercialNumber: row.commercial_number,
    sector: { id: row.sector_id, name: row.sector_name },
    validityDate: row.published_validity_date,
    expired: expired(row.published_validity_date, now),
  };
}
export class ClientBudgetPdfService {
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
    return (this.cursors ??= createBudgetCursorService({
      secret: this.cursorSecret,
    }));
  }
  async authorize(row, clientId, transaction) {
    if (!row || row.client_id !== clientId || !row.published_object_id)
      throw budgetError('notFound');
    await this.authorization.authorizeClientRead(
      {
        clientId,
        budget: {
          clientId: row.client_id,
          publishedObjectId: row.published_object_id,
        },
        slot: 'published',
      },
      transaction,
    );
  }
  async list(input, actor) {
    const clientId = requireBudgetClient(actor);
    strictInput(input, ['limit', 'cursor']);
    const limit = listLimit(input.limit),
      context = { actor: clientId, scope: 'client:published', filters: {} };
    try {
      return await this.objects.transaction(async (transaction) => {
        const cursors = this.cursorService();
        const position = Object.hasOwn(input, 'cursor')
          ? cursors.read(input.cursor, context)
          : undefined;
        const rows = await this.budgets.listClient(
          { clientId, limit, position },
          transaction,
        );
        const page = rows.slice(0, limit),
          now = this.now(),
          last = page.at(-1);
        for (const row of page)
          await this.authorize(row, clientId, transaction);
        return {
          items: page.map((row) => clientBudgetDto(row, now)),
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
      throw budgetError(
        error.code === 'budgetNotFound'
          ? 'notFound'
          : (error.code ?? 'storageUnavailable'),
      );
    }
  }
  async detail(id, actor) {
    const clientId = requireBudgetClient(actor);
    uuid(id);
    try {
      return await this.objects.transaction(async (transaction) => {
        const discovered = await this.budgets.findById(id, transaction);
        await this.authorize(discovered, clientId, transaction);
        const current = await this.budgets.lockBudget(id, transaction, {
          shared: true,
        });
        await this.authorize(current, clientId, transaction);
        // Query the sector label only after owner/current publication revalidation.
        const row = await this.budgets.clientDetail(id, clientId, transaction);
        await this.authorize(row, clientId, transaction);
        return clientBudgetDto(row, this.now());
      });
    } catch (error) {
      throw budgetError(
        error.code === 'budgetNotFound'
          ? 'notFound'
          : (error.code ?? 'storageUnavailable'),
      );
    }
  }
}
export default new ClientBudgetPdfService();
