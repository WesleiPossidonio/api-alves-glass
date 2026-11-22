import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BudgetPdfCreateService } from '../../../src/app/services/BudgetPdfCreateService.js';

export function createScenario(fault) {
  const events = [],
    state = { intent: null, budget: null };
  const actor = { id: randomUUID(), type: 'user' },
    input = {
      sectorId: randomUUID(),
      clientId: randomUUID(),
      commercialNumber: '00042',
      administrativeName: 'Orçamento',
      validityDate: '2027-01-01',
    };
  const fail = (stage) => {
    if (stage === fault)
      throw Object.assign(new Error('private MinIO details'), {
        code: stage === 'prepare' ? 'invalidPdf' : undefined,
      });
  };
  const objects = {
    async transaction(work) {
      events.push('transaction');
      const before = structuredClone(state);
      try {
        const value = await work({});
        events.push('commit');
        return value;
      } catch (error) {
        Object.assign(state, before);
        events.push('rollback');
        throw error;
      }
    },
    async createIntent(values) {
      events.push('intent');
      state.intent = { ...values, state: 'UPLOADING' };
    },
    async lockOwned() {
      events.push('lock');
      return state.intent;
    },
    async compareAndSwapLease({ state: expected, nextState, token, values }) {
      events.push(nextState);
      fail(nextState);
      assert.equal(state.intent.state, expected);
      assert.equal(state.intent.lease_token, token);
      Object.assign(state.intent, values, { state: nextState });
    },
    async scheduleCleanup() {
      events.push('cleanup');
      fail('cleanup');
      if (!state.budget) state.intent.state = 'CLEANUP_PENDING';
    },
  };
  const budgets = {
    async requireReferences() {
      events.push('references');
      fail('references');
    },
    async create(values) {
      events.push('budget');
      fail('budget');
      state.budget = { ...values };
      if (fault === 'duplicate')
        throw {
          original: { code: '23505', constraint: 'budgets_pdf_number_uq' },
        };
    },
  };
  let checks = 0;
  const authorization = {
    async authorizeOperation(values) {
      events.push('auth');
      assert.equal(values.actorId, actor.id);
      assert.equal(values.operation, 'CREATE_EDIT');
      if (fault === 'revoked' && ++checks === 3)
        throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
    },
  };
  const storage = {
    async prepare(bytes, owner) {
      events.push('prepare');
      fail('prepare');
      assert.ok(Buffer.isBuffer(bytes));
      return {
        id: randomUUID(),
        owner_budget_id: owner,
        bucket: 'private',
        object_key: 'private-key',
        size_bytes: '5',
        sha256: 'a'.repeat(64),
      };
    },
    async upload() {
      events.push('PUT');
      assert.ok(state.intent);
      assert.equal(events.at(-2), 'commit');
      fail('PUT');
      return {
        size_bytes: '5',
        sha256: 'a'.repeat(64),
        content_type: 'application/pdf',
      };
    },
  };
  return {
    service: new BudgetPdfCreateService({
      budgets,
      objects,
      authorization,
      storage,
    }),
    actor,
    input,
    events,
    state,
  };
}
