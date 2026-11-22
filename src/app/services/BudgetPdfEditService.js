import {
  BudgetPdfCreateService,
  requireBudgetUser,
} from './BudgetPdfCreateService.js';
import {
  administrativeName,
  assertRevision,
  budgetError,
  civilDate,
  commercialNumber,
  expectedRevision,
  strictInput,
  uuid,
} from './BudgetContractService.js';

export function mutationFailure(error) {
  if (
    error.original?.code === '23505' &&
    error.original.constraint === 'budgets_pdf_number_uq'
  )
    return budgetError('duplicateNumber');
  if (error.original?.code === '23503') return budgetError('validation');
  if (error.original?.code === '55P03') return budgetError('operationBusy');
  return budgetError(error.code ?? 'storageUnavailable');
}
export class BudgetPdfEditService extends BudgetPdfCreateService {
  async edit(id, input, actor, { ifMatch } = {}) {
    const actorId = requireBudgetUser(actor);
    uuid(id);
    strictInput(input, [
      'clientId',
      'sectorId',
      'commercialNumber',
      'administrativeName',
      'validityDate',
    ]);
    if (!Object.keys(input).length) throw budgetError('validation');
    const revision = expectedRevision(ifMatch, id),
      values = {};
    for (const [key, column, validate] of [
      ['clientId', 'client_id', uuid],
      ['sectorId', 'sector_id', uuid],
      ['commercialNumber', 'commercial_number', commercialNumber],
      ['administrativeName', 'administrative_name', administrativeName],
      ['validityDate', 'pending_validity_date', civilDate],
    ]) {
      if (Object.hasOwn(input, key)) values[column] = validate(input[key]);
    }
    try {
      return await this.objects.transaction(async (transaction) => {
        const discovered = await this.budgets.findById(id, transaction);
        if (!discovered) throw budgetError('notFound');
        await this.authorization.authorizeOperations(
          [
            ...new Set(
              [discovered.sector_id, values.sector_id].filter(Boolean),
            ),
          ].map((sectorId) => ({
            actorId,
            sectorId,
            operation: 'CREATE_EDIT',
          })),
          transaction,
        );
        const current = await this.budgets.lockBudget(id, transaction);
        if (!current || current.sector_id !== discovered.sector_id)
          throw budgetError('revisionMismatch');
        assertRevision(revision, String(current.revision));
        if (current.first_published_at) {
          if (
            ['client_id', 'sector_id', 'commercial_number'].some((key) =>
              Object.hasOwn(values, key),
            )
          )
            throw budgetError('identityLocked');
          if (Object.hasOwn(values, 'pending_validity_date'))
            throw budgetError('replacementPdfRequired');
        }
        if (
          Object.hasOwn(values, 'pending_validity_date') &&
          !current.pending_object_id
        )
          throw budgetError('replacementPdfRequired');
        await this.budgets.requireReferences(
          {
            clientId: values.client_id ?? current.client_id,
            sectorId: values.sector_id ?? current.sector_id,
          },
          transaction,
        );
        const updated = await this.budgets.compareAndSwap(
          id,
          revision,
          values,
          transaction,
        );
        return { id, revision: String(updated.revision) };
      });
    } catch (error) {
      throw mutationFailure(error);
    }
  }
}
export default new BudgetPdfEditService();
