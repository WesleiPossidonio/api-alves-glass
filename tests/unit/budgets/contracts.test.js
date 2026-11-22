import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commercialNumber,
  administrativeName,
  civilDate,
  saoPauloDate,
  expired,
  budgetEtag,
  expectedRevision,
  assertRevision,
  listLimit,
  createBudgetCursorService,
  strictInput,
  publicBudgetError,
} from '../../../src/app/services/BudgetContractService.js';
const id = '12345678-1234-4234-8234-123456789abc';
const rejects = (fn, code) => assert.throws(fn, (error) => error.code === code);

test('T020 exact commercial numbers, Unicode limits and strict DTO', () => {
  for (const value of [
    '001',
    '1',
    'Ab',
    'ab',
    'a b',
    'é',
    'e\u0301',
    '😀'.repeat(64),
  ])
    assert.equal(commercialNumber(value), value);
  for (const value of [
    '',
    ' a',
    'a ',
    'a\n',
    '\u007f',
    'a'.repeat(65),
    1,
    null,
  ])
    rejects(() => commercialNumber(value), 'validation');
  assert.equal(administrativeName(' <nome> '), ' <nome> ');
  for (const value of [' ', '\t', 'a'.repeat(241)])
    rejects(() => administrativeName(value), 'validation');
  rejects(() => strictInput({ bucket: 'secret' }, ['name']), 'validation');
  rejects(() => strictInput({}, ['name'], ['name']), 'validation');
});
test('T020 strict Gregorian civil dates and São Paulo expiration', () => {
  for (const value of ['0001-01-01', '9999-12-31', '2000-02-29', '2024-02-29'])
    assert.equal(civilDate(value), value);
  for (const value of [
    '0000-01-01',
    '1900-02-29',
    '2026-02-29',
    '2026-04-31',
    '2026-00-01',
    '2026-01-00',
    '2026-1-01',
    '2026-01-01Z',
    '2026-01-01T00:00:00-03:00',
  ])
    rejects(() => civilDate(value), 'validation');
  const now = new Date('2026-11-17T01:00:00Z');
  assert.equal(saoPauloDate(now), '2026-11-16');
  assert.equal(expired('2026-11-16', now), false);
  assert.equal(expired('2026-11-15', now), true);
});
test('T020 strong scoped ETag without bigint precision loss', () => {
  assert.equal(
    expectedRevision(budgetEtag(id, '9007199254740993'), id),
    '9007199254740993',
  );
  rejects(() => expectedRevision(undefined, id), 'revisionRequired');
  for (const value of [
    '*',
    'W/' + budgetEtag(id, '1'),
    budgetEtag(id, '1') + ', "other"',
    '"budget-' + id + '-9223372036854775808"',
  ])
    rejects(() => expectedRevision(value, id), 'revisionMismatch');
  rejects(() => assertRevision('1', '2'), 'revisionMismatch');
  assert.equal(listLimit(), 25);
  assert.equal(listLimit('100'), 100);
  for (const value of [0, 101, '01', '1.0', null, ' 25'])
    rejects(() => listLimit(value), 'validation');
});
test('T020 cursor HMAC bound to actor/scope/filters/order, tamper and TTL', () => {
  let now = 1000000;
  const service = createBudgetCursorService({
    secret: 's'.repeat(32),
    now: () => now,
  });
  const context = {
    actor: id,
    scope: 'sector:' + id,
    filters: { client: id, commercialNumber: '001' },
  };
  const last = { createdAt: '2026-11-17T01:00:00.123456Z', id };
  const token = service.issue(context, last);
  assert.deepEqual(service.read(token, context), last);
  for (const changed of [
    { ...context, actor: 'other' },
    { ...context, scope: 'client' },
    { ...context, filters: {} },
  ])
    rejects(() => service.read(token, changed), 'invalidCursor');
  rejects(
    () => service.read(token.slice(0, -4) + 'aaaa', context),
    'invalidCursor',
  );
  now += 899999;
  assert.deepEqual(service.read(token, context), last);
  now++;
  rejects(() => service.read(token, context), 'invalidCursor');
  now = 999999;
  rejects(() => service.read(token, context), 'invalidCursor');
  assert.deepEqual(
    publicBudgetError({ code: 'NoSuchKey', message: 'bucket/key secret' }),
    { status: 503, body: { error: 'storageUnavailable' } },
  );
});

test('T022 untyped failures are unavailable, never mistaken for client validation', () => {
  for (const error of [
    undefined,
    null,
    new Error('internal private failure'),
    {},
  ])
    assert.deepEqual(publicBudgetError(error), {
      status: 503,
      body: { error: 'storageUnavailable' },
    });
});
