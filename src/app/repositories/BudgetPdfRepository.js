import { QueryTypes } from 'sequelize';
import BudgetPdf from '../models/BudgetPdf.js';

export function requireBudgetTransaction(transaction) {
  if (!transaction || transaction.finished)
    throw new Error('BUDGET_ACTIVE_TRANSACTION_REQUIRED');
}

export class BudgetPdfRepositoryClient {
  constructor(model = BudgetPdf) {
    this.model = model;
  }
  query(sql, replacements, transaction, type = QueryTypes.SELECT) {
    requireBudgetTransaction(transaction);
    return this.model.sequelize.query(sql, { replacements, transaction, type });
  }
  async lockBudget(id, transaction, { shared = false } = {}) {
    await this.query(
      `SELECT pg_advisory_xact_lock${shared ? '_shared' : ''}(hashtextextended(:key, 0))`,
      { key: `budget-pdf:${id}` },
      transaction,
    );
    return this.model.findByPk(id, {
      transaction,
      lock: shared ? transaction.LOCK.SHARE : transaction.LOCK.UPDATE,
    });
  }
  create(values, transaction) {
    requireBudgetTransaction(transaction);
    return this.model.create(values, { transaction });
  }
  async requireReferences({ clientId, sectorId }, transaction) {
    // Only identities, never Client authentication columns. SHARE keeps FKs
    // stable until commit, in the same order for all creation attempts.
    for (const [table, id] of [
      ['client', clientId],
      ['sectors', sectorId],
    ]) {
      if (
        !(
          await this.query(
            `SELECT id FROM public.${table} WHERE id=:id FOR SHARE`,
            { id },
            transaction,
          )
        ).length
      )
        throw Object.assign(new Error('validation'), { code: 'validation' });
    }
  }
  findById(id, transaction) {
    requireBudgetTransaction(transaction);
    return this.model.findByPk(id, { transaction });
  }
  listInternal(
    { sectorId, clientId, commercialNumber, limit, position },
    transaction,
  ) {
    return this.query(
      `SELECT b.*,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
       FROM public.budgets_pdf b WHERE sector_id=:sectorId
       ${clientId !== undefined ? 'AND client_id=:clientId' : ''}
       ${commercialNumber !== undefined ? 'AND commercial_number=:commercialNumber COLLATE "C"' : ''}
       ${position ? 'AND (created_at,id)<(CAST(:createdAt AS timestamptz),CAST(:lastId AS uuid))' : ''}
       ORDER BY created_at DESC,id DESC LIMIT :count`,
      {
        sectorId,
        clientId,
        commercialNumber,
        count: limit + 1,
        ...(position
          ? { createdAt: position.createdAt, lastId: position.id }
          : {}),
      },
      transaction,
    );
  }
  listClient({ clientId, limit, position }, transaction) {
    return this.query(
      `SELECT b.*,s.name AS sector_name,
       to_char(b.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
       FROM public.budgets_pdf b JOIN public.sectors s ON s.id=b.sector_id
       WHERE b.client_id=:clientId AND b.published_object_id IS NOT NULL
       ${position ? 'AND (b.created_at,b.id)<(CAST(:createdAt AS timestamptz),CAST(:lastId AS uuid))' : ''}
       ORDER BY b.created_at DESC,b.id DESC LIMIT :count`,
      {
        clientId,
        count: limit + 1,
        ...(position
          ? { createdAt: position.createdAt, lastId: position.id }
          : {}),
      },
      transaction,
    );
  }
  async clientDetail(id, clientId, transaction) {
    const [row] = await this.query(
      `SELECT b.*,s.name AS sector_name FROM public.budgets_pdf b
       JOIN public.sectors s ON s.id=b.sector_id
       WHERE b.id=:id AND b.client_id=:clientId AND b.published_object_id IS NOT NULL`,
      { id, clientId },
      transaction,
    );
    return row;
  }
  async compareAndSwap(id, expectedRevision, values, transaction) {
    requireBudgetTransaction(transaction);
    if (!/^[1-9]\d*$/.test(String(expectedRevision)))
      throw new Error('BUDGET_REVISION_REQUIRED');
    const allowed = [
      'client_id',
      'sector_id',
      'commercial_number',
      'administrative_name',
      'first_published_at',
      'pending_object_id',
      'pending_validity_date',
      'published_object_id',
      'published_validity_date',
    ];
    if (Object.keys(values).some((key) => !allowed.includes(key)))
      throw new Error('BUDGET_IMMUTABLE_FIELD');
    const [count, rows] = await this.model.update(
      { ...values, revision: (BigInt(expectedRevision) + 1n).toString() },
      {
        where: { id, revision: String(expectedRevision) },
        transaction,
        returning: true,
      },
    );
    if (count !== 1)
      throw Object.assign(new Error('revisionMismatch'), {
        code: 'revisionMismatch',
        status: 412,
      });
    return rows[0];
  }
  async remove(id, expectedRevision, transaction) {
    requireBudgetTransaction(transaction);
    const count = await this.model.destroy({
      where: { id, revision: String(expectedRevision) },
      transaction,
    });
    if (count !== 1)
      throw Object.assign(new Error('revisionMismatch'), {
        code: 'revisionMismatch',
        status: 412,
      });
  }
  async referencesObject(objectId, transaction) {
    const rows = await this.query(
      `SELECT id FROM public.budgets_pdf
      WHERE pending_object_id=:objectId OR published_object_id=:objectId LIMIT 1`,
      { objectId },
      transaction,
    );
    return rows.length > 0;
  }
}
export default new BudgetPdfRepositoryClient();
