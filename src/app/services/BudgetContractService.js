import { createHmac, timingSafeEqual } from 'node:crypto';

const statuses = {
  validation: 400,
  invalidCursor: 400,
  revisionRequired: 428,
  revisionMismatch: 412,
  forbidden: 403,
  selfGrantForbidden: 403,
  notFound: 404,
  duplicateNumber: 409,
  identityLocked: 409,
  replacementPdfRequired: 409,
  noPendingPdf: 409,
  operationBusy: 409,
  fileTooLarge: 413,
  unsupportedMediaType: 415,
  invalidPdf: 422,
  passwordRequired: 422,
  resourceLimit: 429,
  storageUnavailable: 503,
  validatorUnavailable: 503,
  validatorTimeout: 503,
  validatorFailed: 503,
  budgetLeaseLost: 409,
};
export class BudgetContractError extends Error {
  constructor(code = 'validation') {
    const safe = Object.hasOwn(statuses, code) ? code : 'storageUnavailable';
    super(safe);
    this.code = safe;
    this.status = statuses[safe];
  }
}
export const budgetError = (code) => new BudgetContractError(code);
export function publicBudgetError(error) {
  const safe = budgetError(error?.code ?? 'storageUnavailable');
  return { status: safe.status, body: { error: safe.code } };
}
export function uuid(value) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw budgetError('validation');
  return value;
}
export function strictInput(value, allowed, required = []) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw budgetError('validation');
  return value;
}
function text(value, max) {
  if (
    typeof value !== 'string' ||
    [...value].length < 1 ||
    [...value].length > max ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !value.trim()
  )
    throw budgetError('validation');
  return value;
}
export function commercialNumber(value) {
  text(value, 64);
  if (value !== value.trim()) throw budgetError('validation');
  return value;
}
export const administrativeName = (value) => text(value, 240);
export function civilDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw budgetError('validation');
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1])
    throw budgetError('validation');
  return value;
}
export function saoPauloDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return civilDate(
    `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`,
  );
}
export const expired = (date, now) => civilDate(date) < saoPauloDate(now);
function revision(value) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d*$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw budgetError('validation');
  return value;
}
export const budgetEtag = (id, rev) => `"budget-${uuid(id)}-${revision(rev)}"`;
export function expectedRevision(header, id) {
  if (header == null || header === '') throw budgetError('revisionRequired');
  uuid(id);
  const match =
    typeof header === 'string' &&
    header.match(new RegExp(`^"budget-${id}-([1-9][0-9]*)"$`));
  if (!match) throw budgetError('revisionMismatch');
  try {
    return revision(match[1]);
  } catch {
    throw budgetError('revisionMismatch');
  }
}
export function assertRevision(expected, actual) {
  if (revision(expected) !== revision(actual))
    throw budgetError('revisionMismatch');
}
export function listLimit(value) {
  if (value === undefined) return 25;
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(String(value)))
    throw budgetError('validation');
  return Number(value);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const encode = (value) => JSON.stringify(canonical(value));
export function createBudgetCursorService({ secret, now = Date.now } = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32)
    throw budgetError('validation');
  const sign = (body) => createHmac('sha256', secret).update(body).digest();
  function binding(context) {
    strictInput(
      context,
      ['actor', 'scope', 'filters'],
      ['actor', 'scope', 'filters'],
    );
    uuid(context.actor);
    if (
      typeof context.scope !== 'string' ||
      !context.scope ||
      !context.filters ||
      typeof context.filters !== 'object' ||
      Array.isArray(context.filters)
    )
      throw budgetError('invalidCursor');
    return context;
  }
  function position(value) {
    strictInput(value, ['createdAt', 'id'], ['createdAt', 'id']);
    uuid(value.id);
    if (
      typeof value.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?Z$/.test(
        value.createdAt,
      ) ||
      !Number.isFinite(Date.parse(value.createdAt))
    )
      throw budgetError('invalidCursor');
    civilDate(value.createdAt.slice(0, 10));
    return value;
  }
  return {
    issue(context, last) {
      const body = Buffer.from(
        encode({
          v: 1,
          context: binding(context),
          position: position(last),
          issued: now(),
          order: 'created_at DESC,id DESC',
        }),
      ).toString('base64url');
      return `${body}.${sign(body).toString('base64url')}`;
    },
    read(token, context) {
      try {
        binding(context);
        if (
          typeof token !== 'string' ||
          token.length > 8192 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
        )
          throw new Error();
        const [body, mac] = token.split('.');
        const actual = Buffer.from(mac, 'base64url');
        if (actual.length !== 32 || !timingSafeEqual(sign(body), actual))
          throw new Error();
        const data = JSON.parse(
          Buffer.from(body, 'base64url').toString('utf8'),
        );
        if (
          data.v !== 1 ||
          data.order !== 'created_at DESC,id DESC' ||
          !Number.isSafeInteger(data.issued) ||
          data.issued > now() ||
          now() - data.issued >= 900000 ||
          encode(data.context) !== encode(context)
        )
          throw new Error();
        return position(data.position);
      } catch {
        throw budgetError('invalidCursor');
      }
    },
  };
}
