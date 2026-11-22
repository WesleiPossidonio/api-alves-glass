import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  budgetEtag,
  budgetError,
} from '../../../src/app/services/BudgetContractService.js';
import { BudgetPdfController } from '../../../src/app/controllers/BudgetPdfController.js';

async function scenario() {
  const id = randomUUID(),
    actor = { id: randomUUID(), type: 'user' };
  const state = {
    budget: { id, sector_id: randomUUID(), revision: '4' },
    objects: ['ATTACHED', 'UPLOADING', 'REMOVED'].map((state) => ({
      id: randomUUID(),
      owner_budget_id: id,
      state,
      lease_token: randomUUID(),
    })),
  };
  const events = [],
    transaction = {};
  const objects = {
    async transaction(work) {
      const before = structuredClone(state);
      try {
        const result = await work(transaction);
        events.push('commit');
        return result;
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
    },
    async lockOwnerObjects(owner, tx) {
      assert.equal(owner, id);
      assert.equal(tx, transaction);
      events.push('objects');
      return state.objects;
    },
    async enqueueOwnerCleanup(owner, tx) {
      assert.equal(owner, id);
      assert.equal(tx, transaction);
      assert.equal(state.budget, null);
      events.push('enqueue');
      for (const row of state.objects)
        if (row.state !== 'REMOVED')
          Object.assign(row, { state: 'CLEANUP_PENDING', lease_token: null });
    },
  };
  const budgets = {
    async findById() {
      return state.budget;
    },
    async lockBudget(owner, tx) {
      assert.equal(owner, id);
      assert.equal(tx, transaction);
      events.push('lock');
      return state.budget;
    },
    async remove(owner, revision, tx) {
      assert.equal(owner, id);
      assert.equal(revision, '4');
      assert.equal(tx, transaction);
      events.push('remove');
      state.budget = null;
    },
  };
  const authorization = {
    async authorizeOperation(input, tx) {
      assert.equal(tx, transaction);
      assert.equal(input.actorId, actor.id);
      assert.equal(input.operation, 'DELETE');
      events.push('authorize');
    },
  };
  const { BudgetPdfDeleteService } = await import(
    '../../../src/app/services/BudgetPdfDeleteService.js'
  );
  return {
    id,
    actor,
    state,
    events,
    objects,
    budgets,
    authorization,
    service: new BudgetPdfDeleteService({ budgets, objects, authorization }),
    input: { confirmBudgetId: id },
    options: { ifMatch: budgetEtag(id, '4') },
  };
}

test('T047 DELETE confirmation, revision and allowlist fail closed before removal', async () => {
  const s = await scenario();
  for (const input of [
    undefined,
    {},
    { confirmBudgetId: randomUUID() },
    { confirmBudgetId: s.id, objectKey: 'injected' },
  ])
    await assert.rejects(s.service.delete(s.id, input, s.actor, s.options), {
      code: 'validation',
    });
  await assert.rejects(s.service.delete(s.id, s.input, s.actor), {
    code: 'revisionRequired',
  });
  await assert.rejects(
    s.service.delete(s.id, s.input, s.actor, {
      ifMatch: budgetEtag(s.id, '3'),
    }),
    { code: 'revisionMismatch' },
  );
  await assert.rejects(
    s.service.delete(s.id, s.input, { ...s.actor, type: 'client' }, s.options),
    { code: 'forbidden' },
  );
  assert.ok(s.state.budget);
  assert.ok(!s.events.includes('remove'));
});
test('T047 DELETE has independent authority, same transaction and durable cleanup without storage calls', async () => {
  const s = await scenario();
  assert.deepEqual(await s.service.delete(s.id, s.input, s.actor, s.options), {
    id: s.id,
    deleted: true,
    cleanupPending: true,
  });
  assert.deepEqual(s.events, [
    'authorize',
    'lock',
    'objects',
    'authorize',
    'remove',
    'enqueue',
    'commit',
  ]);
  assert.equal(s.state.budget, null);
  assert.deepEqual(
    s.state.objects.map((x) => x.state),
    ['CLEANUP_PENDING', 'CLEANUP_PENDING', 'REMOVED'],
  );
  await assert.rejects(s.service.delete(s.id, s.input, s.actor, s.options), {
    code: 'notFound',
  });
});
test('T047 rollback and authorization revalidation preserve record and leases', async () => {
  for (const failure of ['remove', 'enqueue', 'revoked', 'scope']) {
    const s = await scenario(),
      before = structuredClone(s.state);
    if (failure === 'remove')
      s.budgets.remove = async () => {
        throw Error('secret database details');
      };
    if (failure === 'enqueue') {
      const enqueue = s.objects.enqueueOwnerCleanup;
      s.objects.enqueueOwnerCleanup = async (...args) => {
        await enqueue(...args);
        throw Error('private key');
      };
    }
    if (failure === 'revoked') {
      let checks = 0;
      s.authorization.authorizeOperation = async () => {
        if (++checks === 2) throw budgetError('forbidden');
      };
    }
    if (failure === 'scope')
      s.budgets.lockBudget = async () => ({
        ...s.state.budget,
        sector_id: randomUUID(),
      });
    await assert.rejects(s.service.delete(s.id, s.input, s.actor, s.options), {
      code:
        failure === 'revoked'
          ? 'forbidden'
          : failure === 'scope'
            ? 'revisionMismatch'
            : 'storageUnavailable',
    });
    assert.deepEqual(s.state, before);
  }
});
test('T047 HTTP202 is commercial deletion, not physical cleanup completion or implicit READ', async () => {
  const id = randomUUID(),
    actor = randomUUID(),
    expected = { id, deleted: true, cleanupPending: true };
  const controller = new BudgetPdfController({
    delete: {
      async delete(...args) {
        assert.deepEqual(args, [
          id,
          { confirmBudgetId: id },
          { id: actor, type: 'user' },
          { ifMatch: budgetEtag(id, '4') },
        ]);
        return expected;
      },
    },
  });
  let status;
  const response = {
    locals: {},
    status(value) {
      status = value;
      return this;
    },
    json(body) {
      assert.equal(status, 202);
      assert.deepEqual(body, expected);
    },
  };
  await controller.delete(
    {
      params: { id },
      body: { confirmBudgetId: id },
      query: {},
      userId: actor,
      actorType: 'user',
      get: () => budgetEtag(id, '4'),
    },
    response,
  );
});
test('T047 HTTP sanitizes errors and rejects query mass assignment', async () => {
  for (const code of [
    'revisionRequired',
    'revisionMismatch',
    'forbidden',
    'notFound',
    'operationBusy',
    'storageUnavailable',
  ]) {
    const error = budgetError(code),
      controller = new BudgetPdfController({
        delete: {
          async delete() {
            throw error;
          },
        },
      });
    await controller.delete(
      {
        params: { id: randomUUID() },
        body: {},
        query: {},
        get: () => undefined,
      },
      {
        locals: {},
        status(status) {
          assert.equal(status, error.status);
          return this;
        },
        json(body) {
          assert.equal(
            body.error.code,
            code === 'notFound' ? 'budgetNotFound' : code,
          );
          assert.ok(!JSON.stringify(body).includes('stack'));
        },
      },
    );
  }
});
