import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BudgetPdfPublishService } from '../../../src/app/services/BudgetPdfPublishService.js';
import {
  ClientBudgetPdfService,
  clientBudgetDto,
} from '../../../src/app/services/ClientBudgetPdfService.js';
import { budgetEtag } from '../../../src/app/services/BudgetContractService.js';

function scenario() {
  const actor = { id: randomUUID(), type: 'user' };
  const row = {
    id: randomUUID(),
    sector_id: randomUUID(),
    client_id: randomUUID(),
    commercial_number: '00042',
    administrative_name: 'Synthetic',
    sector_name: 'Synthetic',
    revision: '1',
    pending_object_id: randomUUID(),
    pending_validity_date: '2020-01-01',
    published_object_id: null,
    first_published_at: null,
  };
  const candidate = {
    id: row.pending_object_id,
    owner_budget_id: row.id,
    state: 'ATTACHED',
    size_bytes: '5',
    sha256: 'a'.repeat(64),
    content_type: 'application/pdf',
    confirmed_at: new Date(),
    lease_token: null,
    lease_until: null,
  };
  const calls = [];
  const budgets = {
    async findById() {
      return { ...row };
    },
    async lockBudget() {
      calls.push('lock');
      return { ...row };
    },
    async compareAndSwap(id, revision, values) {
      calls.push('CAS');
      Object.assign(row, values, { revision: String(BigInt(revision) + 1n) });
      return row;
    },
    async listClient() {
      return [{ ...row, cursor_created_at: '2026-01-01T00:00:00.000001Z' }];
    },
    async clientDetail() {
      return { ...row };
    },
  };
  const objects = {
    async transaction(fn) {
      const saved = { ...row };
      try {
        return await fn({});
      } catch (e) {
        for (const key of Object.keys(row)) delete row[key];
        Object.assign(row, saved);
        throw e;
      }
    },
    async lockObjects() {
      return [candidate];
    },
    async enqueueDetached() {
      calls.push('cleanup');
    },
  };
  const authorization = {
    async authorizeOperation(input) {
      calls.push(input.operation);
    },
    async authorizeClientRead({ clientId, budget }) {
      if (budget.clientId !== clientId || !budget.publishedObjectId)
        throw Object.assign(new Error(), { code: 'budgetNotFound' });
    },
  };
  const service = new BudgetPdfPublishService({
    budgets,
    objects,
    authorization,
    storage: {
      async stat() {
        calls.push('stat');
        return { size: 5 };
      },
    },
  });
  const portal = new ClientBudgetPdfService({
    budgets,
    objects,
    authorization,
    cursorSecret: 'unit-only-portal-secret-with-32-bytes',
    now: () => new Date('2026-11-17T03:00:00Z'),
  });
  return {
    actor,
    row,
    candidate,
    calls,
    service,
    portal,
    client: { id: row.client_id, type: 'client' },
  };
}
const publish = (
  s,
  input = { pendingDocumentId: s.row.pending_object_id },
  etag = budgetEtag(s.row.id, s.row.revision),
) => s.service.publish(s.row.id, input, s.actor, { ifMatch: etag });

test('T032 PUBLISH only, manual atomic pair, minimal result, no READ or PUT/DELETE', async () => {
  const s = scenario();
  assert.equal(s.row.published_object_id, null);
  const pending = s.row.pending_object_id;
  assert.deepEqual(await publish(s), { id: s.row.id, revision: '2' });
  assert.equal(s.row.published_object_id, pending);
  assert.equal(s.row.published_validity_date, '2020-01-01');
  assert.equal(s.row.pending_object_id, null);
  assert.equal(s.row.pending_validity_date, null);
  assert.ok(s.row.first_published_at);
  assert.ok(s.calls.includes('PUBLISH'));
  assert.ok(!s.calls.includes('READ'));
});
test('T032 missing/stale If-Match, foreign candidate, no candidate and unknown fields fail closed', async () => {
  for (const [mode, code] of [
    ['missing', 'revisionRequired'],
    ['stale', 'revisionMismatch'],
    ['candidate', 'revisionMismatch'],
    ['empty', 'noPendingPdf'],
    ['extra', 'validation'],
  ]) {
    const s = scenario();
    if (mode === 'empty') s.row.pending_object_id = null;
    const input = {
      pendingDocumentId: mode === 'candidate' ? randomUUID() : s.candidate.id,
      ...(mode === 'extra' ? { author: s.actor.id } : {}),
    };
    await assert.rejects(
      s.service.publish(s.row.id, input, s.actor, {
        ifMatch:
          mode === 'missing'
            ? undefined
            : budgetEtag(s.row.id, mode === 'stale' ? '2' : '1'),
      }),
      { code },
    );
    assert.equal(s.row.published_object_id, null);
  }
});
test('T032 revocation between stat and commit denies; invalid or leased candidate denied', async () => {
  const s = scenario();
  let calls = 0;
  s.service.authorization.authorizeOperation = async () => {
    if (++calls === 2) throw Object.assign(new Error(), { code: 'forbidden' });
  };
  await assert.rejects(publish(s), { code: 'forbidden' });
  assert.equal(s.row.published_object_id, null);
  for (const change of [
    { state: 'READY' },
    { lease_token: randomUUID() },
    { confirmed_at: null },
    { owner_budget_id: randomUUID() },
  ]) {
    const invalid = scenario();
    Object.assign(invalid.candidate, change);
    await assert.rejects(publish(invalid), { code: 'storageUnavailable' });
  }
});
test('T032 subsequent publication preserves first milestone; cleanup error rolls back entire pair', async () => {
  const s = scenario();
  const first = new Date('2020-01-01Z');
  s.row.first_published_at = first;
  s.row.published_object_id = randomUUID();
  s.service.objects.enqueueDetached = async () => {
    throw new Error('private key');
  };
  const before = { ...s.row };
  await assert.rejects(publish(s), { code: 'storageUnavailable' });
  assert.deepEqual(s.row, before);
  s.service.objects.enqueueDetached = async () => {};
  await publish(s);
  assert.equal(s.row.first_published_at, first);
});
test('T032 portal owner-only published DTO, expiry does not hide document, uniform404', async () => {
  const s = scenario();
  await assert.rejects(s.portal.detail(s.row.id, s.client), {
    code: 'notFound',
  });
  await publish(s);
  const dto = await s.portal.detail(s.row.id, s.client);
  assert.deepEqual(Object.keys(dto).sort(), [
    'administrativeName',
    'commercialNumber',
    'expired',
    'id',
    'sector',
    'validityDate',
  ]);
  assert.equal(dto.expired, true);
  assert.equal(dto.validityDate, '2020-01-01');
  await assert.rejects(
    s.portal.detail(s.row.id, { id: randomUUID(), type: 'client' }),
    { code: 'notFound' },
  );
  await assert.rejects(s.portal.list({ clientId: s.client.id }, s.client), {
    code: 'validation',
  });
  await assert.rejects(s.portal.list({}, s.actor), { code: 'forbidden' });
  assert.equal(
    clientBudgetDto(
      { ...s.row, published_validity_date: '2026-11-16' },
      new Date('2026-11-17T01:00:00Z'),
    ).expired,
    false,
  );
});
test('T032 cursor bound to client and portal scope, forged cursor rejected; empty page valid', async () => {
  const s = scenario();
  await publish(s);
  const original = s.portal.budgets.listClient;
  s.portal.budgets.listClient = async () =>
    [s.row, { ...s.row, id: randomUUID() }].map((r) => ({
      ...r,
      cursor_created_at: '2026-01-01T00:00:00.000001Z',
    }));
  const page = await s.portal.list({ limit: 1 }, s.client);
  assert.ok(page.nextCursor);
  await assert.rejects(
    s.portal.list(
      { cursor: page.nextCursor },
      { id: randomUUID(), type: 'client' },
    ),
    { code: 'invalidCursor' },
  );
  await assert.rejects(
    s.portal.list({ cursor: page.nextCursor + 'x' }, s.client),
    { code: 'invalidCursor' },
  );
  s.portal.budgets.listClient = async () => [];
  assert.deepEqual(await s.portal.list({}, s.client), {
    items: [],
    nextCursor: null,
  });
  s.portal.budgets.listClient = original;
});
test('T034 missing object or changed scope during lock cannot publish; stat outside transactions', async () => {
  const s = scenario();
  let inside = false;
  const transaction = s.service.objects.transaction;
  s.service.objects.transaction = async (fn) =>
    transaction(async (tx) => {
      inside = true;
      try {
        return await fn(tx);
      } finally {
        inside = false;
      }
    });
  s.service.storage.stat = async () => {
    assert.equal(inside, false);
    return null;
  };
  await assert.rejects(publish(s), { code: 'storageUnavailable' });
  assert.equal(s.row.published_object_id, null);
  const moved = scenario();
  moved.service.budgets.lockBudget = async () => ({
    ...moved.row,
    sector_id: randomUUID(),
  });
  await assert.rejects(publish(moved), { code: 'notFound' });
  assert.equal(moved.row.published_object_id, null);
});
test('T035 rechecks owner/publication after shared lock and has no pending fallback', async () => {
  for (const change of [
    { client_id: randomUUID() },
    { published_object_id: null },
  ]) {
    const s = scenario();
    await publish(s);
    s.portal.budgets.lockBudget = async () => ({ ...s.row, ...change });
    await assert.rejects(s.portal.detail(s.row.id, s.client), {
      code: 'notFound',
    });
  }
});
