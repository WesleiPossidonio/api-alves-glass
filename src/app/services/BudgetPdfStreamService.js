import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import budgets from '../repositories/BudgetPdfRepository.js';
import objects from '../repositories/BudgetPdfObjectRepository.js';
import authRepository from '../repositories/BudgetCommercialAuthorizationRepository.js';
import { createBudgetAuthorizationService } from './BudgetAuthorizationService.js';
import { BudgetPdfStorageServiceClient } from './BudgetPdfStorageService.js';
import { requireBudgetUser } from './BudgetPdfCreateService.js';
import { requireBudgetClient } from './ClientBudgetPdfService.js';
import { budgetError, strictInput, uuid } from './BudgetContractService.js';

let activeStreams = 0;
export function budgetPdfRange(value, size) {
  if (value === undefined) return { start: 0, length: size, partial: false };
  if (typeof value !== 'string' || value.length > 128) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const a = Number(match[1]),
    b = Number(match[2]);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
  let start, end;
  if (!match[1]) {
    if (b < 1) return null;
    start = Math.max(0, size - b);
    end = size - 1;
  } else {
    start = a;
    end = match[2] ? Math.min(b, size - 1) : size - 1;
  }
  if (start >= size || start > end) return null;
  return { start, length: end - start + 1, partial: true };
}
export class BudgetPdfStreamService {
  constructor({
    budgets: budgetRepository = budgets,
    objects: objectRepository = objects,
    authorization = createBudgetAuthorizationService({
      repository: authRepository,
    }),
    storage,
    timeoutMs = 60000,
  } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      throw budgetError('validation');
    this.budgets = budgetRepository;
    this.objects = objectRepository;
    this.authorization = authorization;
    this.storage =
      storage ??
      new BudgetPdfStorageServiceClient({ repository: objectRepository });
    this.timeoutMs = timeoutMs;
  }
  // No Express/headers here. T037 maps the immutable delivery descriptor to
  // HTTP before bytes, and maps rejected safe errors to its JSON envelope.
  async stream(input, destination, { signal, onReady = () => {} } = {}) {
    strictInput(
      input,
      ['id', 'actor', 'slot', 'range', 'ifNoneMatch'],
      ['id', 'actor'],
    );
    const id = uuid(input.id),
      client = input.actor?.type === 'client';
    const actorId = client
      ? requireBudgetClient(input.actor)
      : requireBudgetUser(input.actor);
    if (client && Object.hasOwn(input, 'slot')) throw budgetError('validation');
    const slot = client ? 'published' : input.slot;
    if (!['published', 'pending'].includes(slot))
      throw budgetError('validation');
    const disposition = 'attachment';
    if (activeStreams >= 4) throw budgetError('resourceLimit');
    activeStreams++;
    const controller = new AbortController();
    const abort = () => controller.abort(budgetError('storageUnavailable'));
    const timer = setTimeout(abort, this.timeoutMs);
    let source,
      deliveryStarted = false;
    const close = () => {
      if (!destination.writableFinished) abort();
    };
    const destroySource = () =>
      source?.destroy(budgetError('storageUnavailable'));
    controller.signal.addEventListener('abort', destroySource);
    signal?.addEventListener('abort', abort, { once: true });
    destination.on('close', close);
    destination.on('error', abort);
    if (signal?.aborted || destination.destroyed) abort();
    const check = () => {
      if (controller.signal.aborted) throw budgetError('storageUnavailable');
    };
    try {
      return await this.objects.transaction(async (transaction) => {
        check();
        const discovered = await this.budgets.findById(id, transaction);
        const authorize = async (row) => {
          if (!row) throw budgetError('notFound');
          if (client) {
            if (row.client_id !== actorId || !row.published_object_id)
              throw budgetError('notFound');
            await this.authorization.authorizeClientRead(
              {
                clientId: actorId,
                budget: {
                  clientId: row.client_id,
                  publishedObjectId: row.published_object_id,
                },
                slot: 'published',
              },
              transaction,
            );
          } else {
            try {
              await this.authorization.authorizeOperation(
                { actorId, sectorId: row.sector_id, operation: 'READ' },
                transaction,
              );
            } catch (error) {
              if (error.code === 'forbidden') throw budgetError('notFound');
              throw error;
            }
          }
        };
        await authorize(discovered);
        const current = await this.budgets.lockBudget(id, transaction, {
          shared: true,
        });
        if (!current || current.sector_id !== discovered.sector_id)
          throw budgetError('notFound');
        if (client) await authorize(current); // no second auth guard after owner lock
        const objectId = current[`${slot}_object_id`];
        if (!objectId) throw budgetError('notFound');
        const [object] = await this.objects.lockObjects(
          [objectId],
          transaction,
          { shared: true },
        );
        check();
        if (
          !object ||
          object.owner_budget_id !== id ||
          object.state !== 'ATTACHED' ||
          object.content_type !== 'application/pdf'
        )
          throw budgetError('storageUnavailable');
        const size = Number(object.size_bytes);
        if (!Number.isSafeInteger(size) || size < 1 || size > 10485760)
          throw budgetError('storageUnavailable');
        const range = budgetPdfRange(input.range, size);
        const descriptor = Object.freeze({
          status: !range ? 416 : range.partial ? 206 : 200,
          size,
          length: range?.length ?? 0,
          contentRange: !range
            ? `bytes */${size}`
            : range.partial
              ? `bytes ${range.start}-${range.start + range.length - 1}/${size}`
              : undefined,
          contentType: 'application/pdf',
          disposition,
          filename: `${id}.pdf`,
          cacheControl: 'private,no-store,max-age=0',
          vary: 'Cookie',
          contentSecurityPolicy: 'sandbox',
          nosniff: true,
          acceptRanges: 'bytes',
        });
        if (!range) {
          await onReady(descriptor);
          destination.end();
          return descriptor;
        }
        const stat = await this.storage.stat(object, {
          signal: controller.signal,
        });
        check();
        if (!stat || Number(stat.size) !== size)
          throw budgetError('storageUnavailable');
        source = await this.storage.get(object, {
          ...(range.partial
            ? { start: range.start, length: range.length }
            : {}),
          signal: controller.signal,
        });
        // Storage installs its own handler too; injected adapters must not leak
        // a raw upstream error while the transport prepares the descriptor.
        source.on('error', () => {});
        check();
        // Prime at most one upstream chunk before onReady: a GET that opens but
        // fails before any PDF bytes must still permit T037's JSON503 response.
        const iterator = source[Symbol.asyncIterator]();
        const first = await iterator.next();
        check();
        if (first.done || first.value.length > range.length)
          throw budgetError('storageUnavailable');
        const delivery = Readable.from(
          (async function* () {
            yield first.value;
            while (true) {
              const next = await iterator.next();
              if (next.done) return;
              yield next.value;
            }
          })(),
          { objectMode: false },
        );
        // Exact byte count fails closed on truncated/oversized upstream responses.
        let count = 0;
        const bound = new Transform({
          transform(chunk, encoding, done) {
            count += chunk.length;
            done(
              count > range.length ? budgetError('storageUnavailable') : null,
              count > range.length ? undefined : chunk,
            );
          },
          flush(done) {
            done(
              count === range.length ? null : budgetError('storageUnavailable'),
            );
          },
        });
        await onReady(descriptor);
        check();
        deliveryStarted = true;
        await pipeline(delivery, bound, destination, {
          signal: controller.signal,
        });
        return descriptor;
      });
    } catch (error) {
      source?.destroy();
      if (deliveryStarted) destination.destroy();
      throw budgetError(
        error.code === 'budgetNotFound'
          ? 'notFound'
          : (error.original?.code ?? error.code) === '55P03'
            ? 'operationBusy'
            : (error.code ?? 'storageUnavailable'),
      );
    } finally {
      clearTimeout(timer);
      source?.destroy();
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', destroySource);
      destination.removeListener('close', close);
      destination.removeListener('error', abort);
      activeStreams--;
    }
  }
}
export default new BudgetPdfStreamService();
