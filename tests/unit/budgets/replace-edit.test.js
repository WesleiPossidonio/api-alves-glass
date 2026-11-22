import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createScenario } from '../../support/budgets/create-scenario.js';
import {
  budgetEtag,
  budgetError,
} from '../../../src/app/services/BudgetContractService.js';

async function scenario(published = false) {
  const s = createScenario();
  await s.service.create(s.input, s.actor, Buffer.from('%PDF-'));
  const original = s.state.budget.pending_object_id;
  if (published)
    Object.assign(s.state.budget, {
      first_published_at: '2026-01-01',
      published_object_id: randomUUID(),
      published_validity_date: '2026-02-01',
    });
  const deps = s.service,
    operations = [];
  deps.authorization = {
    async authorizeOperation(input) {
      operations.push(input);
    },
    async authorizeOperations(inputs) {
      for (const input of inputs) await this.authorizeOperation(input);
    },
  };
  deps.budgets.findById = deps.budgets.lockBudget = async () => s.state.budget;
  deps.budgets.compareAndSwap = async (id, revision, values) => {
    assert.equal(s.state.budget.revision, revision);
    Object.assign(s.state.budget, values, {
      revision: String(BigInt(revision) + 1n),
    });
    return s.state.budget;
  };
  deps.objects.lockObjects = async () => [s.state.intent];
  deps.objects.enqueueDetached = async (id) => {
    s.events.push(`detached:${id}`);
  };
  deps.objects.scheduleCleanup = async () => {
    if (s.state.intent.id !== s.state.budget.pending_object_id)
      s.state.intent.state = 'CLEANUP_PENDING';
  };
  const { BudgetPdfEditService } = await import(
    '../../../src/app/services/BudgetPdfEditService.js'
  );
  const { BudgetPdfReplacementService } = await import(
    '../../../src/app/services/BudgetPdfReplacementService.js'
  );
  return {
    ...s,
    operations,
    original,
    edit: new BudgetPdfEditService(deps),
    replace: new BudgetPdfReplacementService(deps),
    options: { ifMatch: budgetEtag(s.state.budget.id, '1') },
  };
}
test('T040 private edit validates references, both sectors, revision and exact textual number', async () => {
  const s = await scenario(),
    sectorId = randomUUID();
  const result = await s.edit.edit(
    s.state.budget.id,
    { sectorId, commercialNumber: '0007', validityDate: '2028-02-29' },
    s.actor,
    s.options,
  );
  assert.equal(result.revision, '2');
  assert.equal(s.state.budget.commercial_number, '0007');
  assert.equal(s.state.budget.pending_validity_date, '2028-02-29');
  assert.deepEqual(
    new Set(s.operations.map((x) => x.sectorId)),
    new Set([s.input.sectorId, sectorId]),
  );
  assert.ok(s.operations.every((x) => x.operation === 'CREATE_EDIT'));
});
test('T040 published identity and validity protected, name editable without READ', async () => {
  for (const field of [
    'clientId',
    'sectorId',
    'commercialNumber',
    'validityDate',
    'createdBy',
  ]) {
    const s = await scenario(true);
    await assert.rejects(
      s.edit.edit(
        s.state.budget.id,
        {
          [field]:
            field === 'validityDate'
              ? '2028-01-01'
              : field === 'commercialNumber'
                ? 'new'
                : randomUUID(),
        },
        s.actor,
        s.options,
      ),
      {
        code:
          field === 'createdBy'
            ? 'validation'
            : field === 'validityDate'
              ? 'replacementPdfRequired'
              : 'identityLocked',
      },
    );
  }
  const s = await scenario(true),
    before = structuredClone(s.state.budget);
  await s.edit.edit(
    before.id,
    { administrativeName: 'Novo nome' },
    s.actor,
    s.options,
  );
  assert.deepEqual(s.state.budget, {
    ...before,
    administrative_name: 'Novo nome',
    revision: '2',
  });
});
test('T040 missing/stale revision and mass assignment fail closed', async () => {
  const s = await scenario();
  for (const [options, code] of [
    [{}, 'revisionRequired'],
    [{ ifMatch: budgetEtag(s.state.budget.id, '2') }, 'revisionMismatch'],
  ]) {
    await assert.rejects(
      s.edit.edit(
        s.state.budget.id,
        { administrativeName: 'X' },
        s.actor,
        options,
      ),
      { code },
    );
    await assert.rejects(
      s.replace.replace(
        s.state.budget.id,
        {},
        s.actor,
        Buffer.from('%PDF-'),
        options,
      ),
      { code },
    );
  }
  await assert.rejects(
    s.replace.replace(
      s.state.budget.id,
      { publishedObjectId: randomUUID() },
      s.actor,
      Buffer.from('%PDF-'),
      s.options,
    ),
    { code: 'validation' },
  );
});
test('T040 replacement preserves published pair, inherits pending validity, durable intent and cleanup only after CAS', async () => {
  for (const published of [false, true]) {
    const s = await scenario(published),
      before = structuredClone(s.state.budget);
    const result = await s.replace.replace(
      before.id,
      {},
      s.actor,
      Buffer.from('%PDF-'),
      s.options,
    );
    assert.equal(result.revision, '2');
    assert.notEqual(result.pendingDocumentId, s.original);
    assert.equal(
      s.state.budget.published_object_id,
      before.published_object_id,
    );
    assert.equal(
      s.state.budget.published_validity_date,
      before.published_validity_date,
    );
    assert.equal(
      s.state.budget.pending_validity_date,
      before.pending_validity_date,
    );
    assert.equal(s.state.intent.expected_revision, '1');
    assert.equal(s.state.intent.state, 'ATTACHED');
    assert.ok(s.events.includes(`detached:${s.original}`));
    assert.ok(s.operations.every((x) => x.operation === 'REPLACE_PDF'));
  }
});
test('T040 changed validity requires both permissions; omitted PDF rejected', async () => {
  const s = await scenario(true);
  await assert.rejects(
    s.replace.replace(s.state.budget.id, {}, s.actor, undefined, s.options),
    { code: 'invalidPdf' },
  );
  await s.replace.replace(
    s.state.budget.id,
    { validityDate: '2028-01-01' },
    s.actor,
    Buffer.from('%PDF-'),
    s.options,
  );
  assert.deepEqual(
    new Set(s.operations.map((x) => x.operation)),
    new Set(['REPLACE_PDF', 'CREATE_EDIT']),
  );
});
test('T040 validation, storage, revocation and CAS rollback preserve previous slots', async () => {
  for (const stage of ['prepare', 'upload', 'revocation', 'cas', 'detach']) {
    const s = await scenario(true),
      before = structuredClone(s.state.budget);
    const fail = () => {
      throw budgetError(
        stage === 'prepare'
          ? 'invalidPdf'
          : stage === 'revocation'
            ? 'forbidden'
            : stage === 'cas'
              ? 'revisionMismatch'
              : 'storageUnavailable',
      );
    };
    if (['prepare', 'upload'].includes(stage)) s.replace.storage[stage] = fail;
    if (stage === 'cas') s.replace.budgets.compareAndSwap = fail;
    if (stage === 'detach') s.replace.objects.enqueueDetached = fail;
    if (stage === 'revocation') {
      const upload = s.replace.storage.upload;
      s.replace.storage.upload = async (...args) => {
        const value = await upload(...args);
        s.replace.authorization.authorizeOperation = fail;
        return value;
      };
    }
    await assert.rejects(
      s.replace.replace(
        before.id,
        {},
        s.actor,
        Buffer.from('%PDF-'),
        s.options,
      ),
    );
    assert.deepEqual(s.state.budget, before);
    if (stage !== 'prepare')
      assert.equal(s.state.intent.state, 'CLEANUP_PENDING');
  }
});
