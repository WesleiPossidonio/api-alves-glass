// Public component contracts only. No assertion of future HTTP routes/headers.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  administrativeName,
  commercialNumber,
  strictInput,
  uuid,
  budgetEtag,
  expectedRevision,
  assertRevision,
  civilDate,
  expired,
  saoPauloDate,
  listLimit,
  createBudgetCursorService,
  publicBudgetError,
} from '../../../src/app/services/BudgetContractService.js';
const id = '12345678-1234-4234-8234-123456789abc';
const other = '12345678-1234-4234-8234-123456789abd';
const fails = (fn, code) => assert.throws(fn, (error) => error.code === code);

test('foundation input contract: exact identity, Unicode lengths, no silent normalization or storage fields', () => {
  for (const value of [
    '00042',
    '42',
    'Ab',
    'ab',
    'é',
    'e\u0301',
    '😀'.repeat(64),
  ])
    assert.equal(commercialNumber(value), value);
  assert.notEqual(commercialNumber('00042'), commercialNumber('42'));
  for (const value of ['', 1, null, ' 42', '42 ', 'a\n', '😀'.repeat(65)])
    fails(() => commercialNumber(value), 'validation');
  assert.equal(administrativeName('😀'.repeat(240)), '😀'.repeat(240));
  for (const value of [' ', 'a\u007f', 'a'.repeat(241)])
    fails(() => administrativeName(value), 'validation');
  assert.equal(uuid(id), id);
  fails(() => uuid(id.toUpperCase()), 'validation');
  const fields = ['commercialNumber', 'administrativeName', 'validityDate'];
  const value = {
    commercialNumber: '00042',
    administrativeName: 'Synthetic',
    validityDate: '2027-01-01',
  };
  assert.equal(strictInput(value, fields, fields), value);
  for (const key of [
    'createdBy',
    'sectorId',
    'bucket',
    'objectKey',
    'revision',
    'publishedObjectId',
  ])
    fails(
      () => strictInput({ ...value, [key]: 'untrusted' }, fields, fields),
      'validation',
    );
  fails(() => strictInput({}, fields, fields), 'validation');
});
test('foundation revision contract: strong resource-scoped ETag, bigint preserved, 428 vs 412', () => {
  for (const revision of ['1', '9007199254740993', '9223372036854775807'])
    assert.equal(expectedRevision(budgetEtag(id, revision), id), revision);
  for (const value of [null, undefined, ''])
    fails(() => expectedRevision(value, id), 'revisionRequired');
  for (const value of [
    '*',
    `W/${budgetEtag(id, '1')}`,
    `${budgetEtag(id, '1')},${budgetEtag(id, '2')}`,
    budgetEtag(other, '1'),
    `"budget-${id}-01"`,
    `"budget-${id}-9223372036854775808"`,
  ])
    fails(() => expectedRevision(value, id), 'revisionMismatch');
  fails(() => assertRevision('1', '2'), 'revisionMismatch');
  assert.deepEqual(publicBudgetError({ code: 'revisionRequired' }), {
    status: 428,
    body: { error: 'revisionRequired' },
  });
  assert.deepEqual(publicBudgetError({ code: 'revisionMismatch' }), {
    status: 412,
    body: { error: 'revisionMismatch' },
  });
});
test('foundation civil dates: Gregorian years 0001..9999, no offset/time, São Paulo civil expiry', () => {
  for (const date of ['0001-01-01', '9999-12-31', '2000-02-29'])
    assert.equal(civilDate(date), date);
  for (const date of [
    '0000-01-01',
    '1900-02-29',
    '2026-04-31',
    '2026-1-01',
    '2026-01-01Z',
    '2026-01-01T00:00:00Z',
  ])
    fails(() => civilDate(date), 'validation');
  const now = new Date('2026-11-17T02:59:59Z');
  assert.equal(saoPauloDate(now), '2026-11-16');
  assert.equal(expired('2026-11-16', now), false);
  assert.equal(expired('2026-11-15', now), true);
});
test('foundation pagination: 25 default, max100, HMAC binding and TTL15min, microsecond keyset preserved', () => {
  assert.equal(listLimit(), 25);
  assert.equal(listLimit('100'), 100);
  for (const value of [0, 101, '01', '1.5', ' 25', null])
    fails(() => listLimit(value), 'validation');
  let now = 1000000;
  const secret = 'foundation-contract-only-32bytes!!';
  const cursor = createBudgetCursorService({ secret, now: () => now });
  const context = {
    actor: id,
    scope: `sector:${id}`,
    filters: { commercialNumber: '00042', clientId: other },
  };
  const position = { createdAt: '2026-11-17T00:00:00.123456Z', id: other };
  const token = cursor.issue(context, position);
  assert.deepEqual(cursor.read(token, context), position);
  for (const changed of [
    { ...context, actor: other },
    { ...context, scope: 'client' },
    { ...context, filters: {} },
  ])
    fails(() => cursor.read(token, changed), 'invalidCursor');
  fails(
    () => cursor.read(token.slice(0, -6) + 'abcdef', context),
    'invalidCursor',
  );
  fails(
    () =>
      createBudgetCursorService({
        secret: 'other-secret-long-enough-32bytes!!',
        now: () => now,
      }).read(token, context),
    'invalidCursor',
  );
  now += 899999;
  assert.deepEqual(cursor.read(token, context), position);
  now++;
  fails(() => cursor.read(token, context), 'invalidCursor');
});
test('foundation error boundary: allowlisted status/code only, no SDK fields or secrets', () => {
  for (const [code, status] of Object.entries({
    validation: 400,
    forbidden: 403,
    notFound: 404,
    duplicateNumber: 409,
    fileTooLarge: 413,
    unsupportedMediaType: 415,
    invalidPdf: 422,
    resourceLimit: 429,
    storageUnavailable: 503,
    validatorUnavailable: 503,
  }))
    assert.deepEqual(
      publicBudgetError({
        code,
        message: 'private',
        bucket: 'secret',
        stack: 'secret',
      }),
      { status, body: { error: code } },
    );
  for (const error of [
    undefined,
    { code: 'AccessDenied', message: 'secret bucket/key' },
    new Error('secret'),
  ])
    assert.deepEqual(publicBudgetError(error), {
      status: 503,
      body: { error: 'storageUnavailable' },
    });
});
