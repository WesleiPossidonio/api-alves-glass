import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createScenario } from '../../support/budgets/create-scenario.js';

test('T023 create: validated bytes, durable intent before PUT, real session author, atomic private revision1', async () => {
  const s = createScenario();
  const result = await s.service.create(s.input, s.actor, Buffer.from('%PDF-'));
  assert.deepEqual(Object.keys(result).sort(), [
    'id',
    'pendingDocumentId',
    'revision',
  ]);
  assert.equal(result.revision, '1');
  assert.equal(s.state.budget.created_by, s.actor.id);
  assert.equal(s.state.budget.commercial_number, '00042');
  assert.equal(s.state.budget.pending_validity_date, s.input.validityDate);
  assert.equal(s.state.budget.published_object_id, null);
  assert.equal(s.state.budget.first_published_at, null);
  assert.equal(s.state.intent.state, 'ATTACHED');
  assert.equal(s.events.filter((e) => e === 'auth').length, 3);
  assert.ok(s.events.indexOf('prepare') < s.events.indexOf('intent'));
});
test('T023 strict required fields, file and session author; no effects for invalid data', async () => {
  const base = createScenario();
  for (const field of Object.keys(base.input)) {
    const s = createScenario();
    delete s.input[field];
    await assert.rejects(
      s.service.create(s.input, s.actor, Buffer.from('%PDF-')),
      { code: 'validation' },
    );
    assert.deepEqual(s.events, []);
  }
  for (const extra of [
    'author',
    'createdBy',
    'bucket',
    'objectKey',
    'total_value',
    'items',
  ]) {
    const s = createScenario();
    s.input[extra] = 'forged';
    await assert.rejects(
      s.service.create(s.input, s.actor, Buffer.from('%PDF-')),
      { code: 'validation' },
    );
    assert.deepEqual(s.events, []);
  }
  for (const actor of [null, { id: randomUUID(), type: 'client' }])
    await assert.rejects(
      base.service.create(base.input, actor, Buffer.from('%PDF-')),
    );
  await assert.rejects(base.service.create(base.input, base.actor, undefined), {
    code: 'invalidPdf',
  });
});
test('T023 qpdf/reference rejection produces zero intent and zero PUT', async () => {
  for (const fault of ['prepare', 'references']) {
    const s = createScenario(fault);
    await assert.rejects(
      s.service.create(s.input, s.actor, Buffer.from('%PDF-')),
    );
    assert.equal(s.state.intent, null);
    assert.equal(s.state.budget, null);
    assert.ok(!s.events.includes('PUT'));
  }
});
test('T023 PUT/stat/lease/UNIQUE/revocation failure: rollback budget and durable cleanup, sanitized errors', async () => {
  for (const fault of [
    'PUT',
    'READY',
    'ATTACHED',
    'budget',
    'duplicate',
    'revoked',
  ]) {
    const s = createScenario(fault);
    await assert.rejects(
      s.service.create(s.input, s.actor, Buffer.from('%PDF-')),
      (error) => {
        assert.equal(
          error.code,
          fault === 'duplicate'
            ? 'duplicateNumber'
            : fault === 'revoked'
              ? 'forbidden'
              : 'storageUnavailable',
        );
        assert.ok(!error.message.includes('MinIO'));
        return true;
      },
    );
    assert.equal(s.state.budget, null);
    assert.equal(s.state.intent.state, 'CLEANUP_PENDING');
    assert.ok(s.events.includes('cleanup'));
  }
});
test('T023 abort after external PUT compensates and never attaches', async () => {
  const s = createScenario(),
    controller = new AbortController();
  const upload = s.service.storage.upload.bind(s.service.storage);
  s.service.storage.upload = async (...args) => {
    const result = await upload(...args);
    controller.abort();
    return result;
  };
  await assert.rejects(
    s.service.create(s.input, s.actor, Buffer.from('%PDF-'), {
      signal: controller.signal,
    }),
    { code: 'storageUnavailable' },
  );
  assert.equal(s.state.budget, null);
  assert.equal(s.state.intent.state, 'CLEANUP_PENDING');
});
test('T023 cleanup outage preserves recoverable intent, never masks original failure', async () => {
  const s = createScenario('PUT');
  s.service.objects.scheduleCleanup = async () => {
    throw new Error('DB down');
  };
  await assert.rejects(
    s.service.create(s.input, s.actor, Buffer.from('%PDF-')),
    { code: 'storageUnavailable' },
  );
  assert.equal(s.state.intent.state, 'UPLOADING');
  assert.ok(s.state.intent.lease_until);
  assert.equal(s.state.budget, null);
});
test('T023 ambiguous committed acknowledgement must not enqueue or delete attached object', async () => {
  const s = createScenario(),
    transaction = s.service.objects.transaction.bind(s.service.objects);
  let count = 0;
  s.service.objects.transaction = async (work) => {
    const value = await transaction(work);
    if (++count === 3) throw new Error('commit acknowledgement lost');
    return value;
  };
  await assert.rejects(
    s.service.create(s.input, s.actor, Buffer.from('%PDF-')),
    { code: 'storageUnavailable' },
  );
  assert.ok(s.state.budget);
  assert.equal(s.state.intent.state, 'ATTACHED');
});
