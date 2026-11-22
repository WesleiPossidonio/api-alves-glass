import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import BudgetPdfObject from '../models/BudgetPdfObject.js';
import { requireBudgetTransaction } from './BudgetPdfRepository.js';

export class BudgetPdfObjectRepositoryClient {
  constructor(model = BudgetPdfObject) {
    this.model = model;
  }
  transaction(callback) {
    return this.model.sequelize.transaction(
      { isolationLevel: 'READ COMMITTED' },
      async (transaction) => {
        await this.query(
          "SELECT set_config('lock_timeout','5s',true), set_config('statement_timeout','110s',true), set_config('idle_in_transaction_session_timeout','110s',true)",
          {},
          transaction,
        );
        return callback(transaction);
      },
    );
  }
  async lockOwned(candidate, transaction) {
    await this.query(
      'SELECT pg_advisory_xact_lock(hashtextextended(:key,0))',
      { key: `budget-pdf:${candidate.owner_budget_id}` },
      transaction,
    );
    await this.query(
      'SELECT id FROM public.budgets_pdf WHERE id=:owner FOR UPDATE',
      { owner: candidate.owner_budget_id },
      transaction,
    );
    const [row] = await this.lockObjects([candidate.id], transaction);
    if (row && row.owner_budget_id !== candidate.owner_budget_id)
      throw new Error('BUDGET_OBJECT_OWNER_MISMATCH');
    return row;
  }
  async leaseIsCurrent(row, token, transaction) {
    const rows = await this.query(
      `SELECT id FROM public.budget_pdf_objects WHERE id=:id AND state='CLEANING' AND lease_token=:token AND lease_until>CURRENT_TIMESTAMP`,
      { id: row.id, token },
      transaction,
    );
    return rows.length === 1;
  }
  async reconcileCandidates(transaction, { after = '', limit = 25 } = {}) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 25 ||
      (after && !/^[0-9a-f-]{36}$/.test(after))
    )
      throw new Error('BUDGET_CLAIM_LIMIT');
    return this.query(
      `SELECT * FROM public.budget_pdf_objects
      WHERE (state='REMOVED' OR (state='UPLOADING' AND lease_until<=CURRENT_TIMESTAMP)
        OR (state='READY' AND updated_at<=CURRENT_TIMESTAMP-interval '24 hours'))
        ${after ? 'AND id>CAST(:after AS uuid)' : ''}
      ORDER BY id LIMIT :limit`,
      { after, limit },
      transaction,
    );
  }
  async enqueueUnreferenced(row, transaction) {
    if (await this.referencesObject(row.id, transaction)) return false;
    const rows = await this.query(
      `UPDATE public.budget_pdf_objects SET state='CLEANUP_PENDING',
      lease_token=NULL,lease_until=NULL,removed_at=NULL,next_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE id=:id AND (state='REMOVED' OR (state='UPLOADING' AND lease_until<=CURRENT_TIMESTAMP)
        OR (state='READY' AND updated_at<=CURRENT_TIMESTAMP-interval '24 hours')) RETURNING *`,
      { id: row.id },
      transaction,
    );
    return rows.length === 1;
  }
  async registerUnknown(candidate, actorId, transaction) {
    // Caller holds the reserved owner's advisory lock. Never fabricate commercial
    // ownership: this explicit actor is a provisioned technical User, not a client.
    const existing = await this.query(
      'SELECT id FROM public.budget_pdf_objects WHERE bucket=:bucket AND object_key=:key',
      { bucket: candidate.bucket, key: candidate.object_key },
      transaction,
    );
    if (
      existing.length ||
      (await this.referencesObject(candidate.id, transaction))
    )
      return false;
    const created = await this.createIntent(
      {
        ...candidate,
        created_by: actorId,
        validity_date: '0001-01-01',
        lease_token: randomUUID(),
        lease_until: new Date(),
      },
      transaction,
    );
    await this.query(
      `UPDATE public.budget_pdf_objects SET state='CLEANUP_PENDING',lease_token=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=:id`,
      { id: created.id },
      transaction,
    );
    return true;
  }
  query(sql, replacements, transaction) {
    requireBudgetTransaction(transaction);
    return this.model.sequelize.query(sql, {
      replacements,
      transaction,
      type: QueryTypes.SELECT,
    });
  }
  createIntent(values, transaction) {
    requireBudgetTransaction(transaction);
    return this.model.create(
      { ...values, state: 'UPLOADING' },
      { transaction },
    );
  }
  async scheduleCleanup(proof, token, transaction) {
    const row = await this.lockOwned(proof, transaction);
    if (
      !row ||
      row.lease_token !== token ||
      !['UPLOADING', 'READY'].includes(row.state) ||
      (await this.referencesObject(proof.id, transaction))
    )
      return false;
    // Compensation can enqueue only this attempt, never touch a committed
    // ATTACHED slot (including an ambiguous commit acknowledgement).
    await this.query(
      `UPDATE public.budget_pdf_objects SET state='CLEANUP_PENDING',
      lease_token=NULL,lease_until=NULL,next_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE id=:id AND lease_token=:token AND state IN ('UPLOADING','READY')`,
      { id: proof.id, token },
      transaction,
    );
    return true;
  }
  async lockObjects(ids, transaction, { shared = false } = {}) {
    requireBudgetTransaction(transaction);
    const rows = [];
    for (const id of [...new Set(ids)].sort()) {
      rows.push(
        await this.model.findByPk(id, {
          transaction,
          lock: shared ? transaction.LOCK.SHARE : transaction.LOCK.UPDATE,
        }),
      );
    }
    return rows;
  }
  async enqueueDetached(id, ownerId, transaction) {
    // Caller holds authorization, owner and sorted object locks. Must run after
    // slot CAS in the SAME transaction; never an external DELETE.
    const rows = await this.query(
      `UPDATE public.budget_pdf_objects o SET state='CLEANUP_PENDING',
       lease_token=NULL,lease_until=NULL,next_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
       WHERE o.id=:id AND o.owner_budget_id=:ownerId AND o.state='ATTACHED'
       AND NOT EXISTS(SELECT 1 FROM public.budgets_pdf b WHERE b.pending_object_id=o.id OR b.published_object_id=o.id)
       RETURNING o.id`,
      { id, ownerId },
      transaction,
    );
    if (rows.length !== 1)
      throw Object.assign(new Error('storageUnavailable'), {
        code: 'storageUnavailable',
      });
  }
  lockOwnerObjects(ownerId, transaction) {
    // Caller already holds authorization and exclusive budget/row guards.
    return this.query(
      'SELECT * FROM public.budget_pdf_objects WHERE owner_budget_id=:ownerId ORDER BY id FOR UPDATE',
      { ownerId },
      transaction,
    );
  }
  async enqueueOwnerCleanup(ownerId, transaction) {
    // No owner may remain. Refuse misuse rather than quietly skipping live slots.
    const live = await this.query(
      `SELECT id FROM public.budgets_pdf WHERE id=:ownerId OR
       pending_object_id IN (SELECT id FROM public.budget_pdf_objects WHERE owner_budget_id=:ownerId) OR
       published_object_id IN (SELECT id FROM public.budget_pdf_objects WHERE owner_budget_id=:ownerId) LIMIT 1`,
      { ownerId },
      transaction,
    );
    if (live.length)
      throw Object.assign(new Error('storageUnavailable'), {
        code: 'storageUnavailable',
      });
    // REMOVED remains terminal/reconcilable. CLEANING gets fenced too: a worker
    // with an earlier claim must not complete using the now invalid token.
    return this.query(
      `UPDATE public.budget_pdf_objects SET state='CLEANUP_PENDING',
       lease_token=NULL,lease_until=NULL,next_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
       WHERE owner_budget_id=:ownerId AND state<>'REMOVED' RETURNING id`,
      { ownerId },
      transaction,
    );
  }
  async referencesObject(id, transaction) {
    return (
      (
        await this.query(
          `SELECT id FROM public.budgets_pdf
      WHERE pending_object_id=:id OR published_object_id=:id LIMIT 1`,
          { id },
          transaction,
        )
      ).length > 0
    );
  }
  async compareAndSwapLease(
    { id, token, state, nextState, values = {} },
    transaction,
  ) {
    requireBudgetTransaction(transaction);
    const allowed = [
      'lease_token',
      'lease_until',
      'attempts',
      'next_attempt_at',
      'last_error_code',
      'size_bytes',
      'sha256',
      'content_type',
      'confirmed_at',
      'removed_at',
    ];
    if (Object.keys(values).some((key) => !allowed.includes(key)))
      throw new Error('BUDGET_OBJECT_IMMUTABLE_FIELD');
    const assignments = Object.keys(values)
      .map((key) => `"${key}"=:${key}`)
      .join(', ');
    const rows = await this.query(
      `UPDATE public.budget_pdf_objects SET state=:nextState,
      updated_at=CURRENT_TIMESTAMP${assignments ? `, ${assignments}` : ''}
      WHERE id=:id AND lease_token=:token AND state=:state AND lease_until>CURRENT_TIMESTAMP
      RETURNING *`,
      { ...values, id, token, state, nextState },
      transaction,
    );
    if (rows.length !== 1)
      throw Object.assign(new Error('budgetLeaseLost'), {
        code: 'budgetLeaseLost',
      });
    return rows[0];
  }
  async claimCleanup(transaction, { limit = 25 } = {}) {
    requireBudgetTransaction(transaction);
    if (!Number.isInteger(limit) || limit < 1 || limit > 25)
      throw new Error('BUDGET_CLAIM_LIMIT');
    // Candidate discovery is nonlocking. Never take object rows before budget guard.
    const candidates = await this.query(
      `SELECT id,owner_budget_id FROM public.budget_pdf_objects
      WHERE (state='CLEANUP_PENDING' AND next_attempt_at<=CURRENT_TIMESTAMP)
         OR (state='CLEANING' AND lease_until<=CURRENT_TIMESTAMP)
      ORDER BY next_attempt_at,id LIMIT :limit`,
      { limit },
      transaction,
    );
    const claimed = [];
    for (const candidate of [...candidates].sort(
      (a, b) =>
        a.owner_budget_id.localeCompare(b.owner_budget_id) ||
        a.id.localeCompare(b.id),
    )) {
      const [guard] = await this.query(
        `SELECT pg_try_advisory_xact_lock(hashtextextended(:key,0)) AS acquired`,
        { key: `budget-pdf:${candidate.owner_budget_id}` },
        transaction,
      );
      if (!guard.acquired) continue;
      await this.query(
        'SELECT id FROM public.budgets_pdf WHERE id=:owner FOR UPDATE',
        { owner: candidate.owner_budget_id },
        transaction,
      );
      const rows = await this.query(
        `SELECT * FROM public.budget_pdf_objects WHERE id=:id
        AND ((state='CLEANUP_PENDING' AND next_attempt_at<=CURRENT_TIMESTAMP)
          OR (state='CLEANING' AND lease_until<=CURRENT_TIMESTAMP)) FOR UPDATE SKIP LOCKED`,
        { id: candidate.id },
        transaction,
      );
      if (
        !rows.length ||
        (await this.referencesObject(candidate.id, transaction))
      )
        continue;
      const token = randomUUID();
      const [row] = await this.query(
        `UPDATE public.budget_pdf_objects SET state='CLEANING',
        lease_token=:token,lease_until=CURRENT_TIMESTAMP+interval '2 minutes',attempts=attempts+1,
        updated_at=CURRENT_TIMESTAMP WHERE id=:id RETURNING *`,
        { id: candidate.id, token },
        transaction,
      );
      claimed.push(row);
    }
    return claimed;
  }
}
export default new BudgetPdfObjectRepositoryClient();
