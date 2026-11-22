import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createMinioClient } from '../../config/minio.js';
import objects from '../repositories/BudgetPdfObjectRepository.js';
import { createBudgetPdfValidationService } from './BudgetPdfValidationService.js';
import { createBudgetPdfRuntimeService } from './BudgetPdfRuntimeService.js';
import { budgetError, uuid } from './BudgetContractService.js';

const operations = new AsyncLocalStorage();
const absent = (error) =>
  ['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(error?.code);
export function budgetObjectKey(owner, id) {
  return `budgets-pdf/${uuid(owner)}/${uuid(id)}.pdf`;
}
export function parseBudgetObjectKey(key) {
  const match =
    typeof key === 'string' &&
    key.match(/^budgets-pdf\/([^/]+)\/([^/]+)\.pdf$/);
  if (!match) throw budgetError('validation');
  return { owner_budget_id: uuid(match[1]), id: uuid(match[2]) };
}
// Dedicated instance from the existing configuration factory. Transport scope is
// per async operation: never change the shared legacy client's request options.
export function createBudgetMinioClient(env) {
  const client = createMinioClient(env);
  const transport = client.transport;
  client.transport = {
    request(options, callback) {
      const signal = operations.getStore();
      return transport.request(
        { ...options, ...(signal ? { signal } : {}) },
        callback,
      );
    },
  };
  return client;
}
export class BudgetPdfStorageServiceClient {
  constructor({
    client,
    env = process.env,
    repository = objects,
    validator = createBudgetPdfValidationService(),
    runtime = createBudgetPdfRuntimeService(),
    timeoutMs = 30000,
    streamMs = 60000,
    now = Date.now,
  } = {}) {
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30000 ||
      !Number.isInteger(streamMs) ||
      streamMs < 1 ||
      streamMs > 60000
    )
      throw budgetError('validation');
    this.client = client;
    this.env = env;
    this.repository = repository;
    this.validator = validator;
    this.runtime = runtime;
    this.timeoutMs = timeoutMs;
    this.streamMs = streamMs;
    this.now = now;
    this.proofs = new WeakMap();
    this.streams = 0;
  }
  get bucket() {
    const bucket =
      this.env.MINIO_PRIVATE_BUCKET ?? this.env.MINIO_BUCKET_PRIVATE;
    if (
      !bucket ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      bucket === this.env.MINIO_PUBLIC_BUCKET ||
      (this.env.MINIO_PRIVATE_BUCKET &&
        this.env.MINIO_BUCKET_PRIVATE &&
        this.env.MINIO_PRIVATE_BUCKET !== this.env.MINIO_BUCKET_PRIVATE)
    )
      throw budgetError('storageUnavailable');
    return bucket;
  }
  target(row) {
    if (
      !row ||
      row.bucket !== this.bucket ||
      row.object_key !== budgetObjectKey(row.owner_budget_id, row.id)
    )
      throw budgetError('storageUnavailable');
    return row.object_key;
  }
  async operation(
    callback,
    { signal, duration = this.timeoutMs, streaming = false } = {},
  ) {
    this.bucket; // fail before constructing a client or connecting
    this.client ??= createBudgetMinioClient(this.env);
    const controller = new AbortController();
    let timer;
    const abort = () => controller.abort(budgetError('storageUnavailable'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let stream;
    let retain = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          stream?.destroy(budgetError('storageUnavailable'));
          reject(budgetError('storageUnavailable'));
        },
        { once: true },
      );
    });
    timer = setTimeout(abort, duration);
    try {
      if (controller.signal.aborted) throw budgetError('storageUnavailable');
      const work = operations
        .run(controller.signal, () =>
          Promise.resolve().then(() => callback(this.client)),
        )
        .then((value) => {
          if (controller.signal.aborted && streaming) value?.destroy();
          return value;
        });
      const result = await Promise.race([work, aborted]);
      if (streaming) {
        stream = result;
        retain = true;
        stream.once('close', cleanup);
        // Always install a sanitized stream error handler; callers still handle abort.
        stream.on('error', () => {});
      }
      return result;
    } catch {
      throw budgetError('storageUnavailable');
    } finally {
      if (!retain) cleanup();
    }
  }
  async prepare(input, ownerBudgetId, options = {}) {
    uuid(ownerBudgetId);
    await this.runtime.ensureUploadsReady();
    const result = await this.validator.validate(input, options);
    const bytes = Buffer.from(result.bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== result.sizeBytes || sha256 !== result.sha256)
      throw budgetError('validatorFailed');
    const id = randomUUID();
    const proof = Object.freeze({
      id,
      owner_budget_id: ownerBudgetId,
      bucket: this.bucket,
      object_key: budgetObjectKey(ownerBudgetId, id),
      size_bytes: String(bytes.length),
      sha256,
      content_type: 'application/pdf',
    });
    this.proofs.set(proof, bytes);
    return proof; // Internal only; never a client DTO.
  }
  async upload(proof, token, { signal } = {}) {
    const bytes = this.proofs.get(proof);
    if (!bytes) throw budgetError('validatorFailed');
    this.proofs.delete(proof); // one attempt per immutable key
    const key = this.target(proof);
    const refresh = () =>
      this.repository.transaction(async (transaction) => {
        const row = await this.repository.lockOwned(proof, transaction);
        if (!row || row.bucket !== proof.bucket || row.object_key !== key)
          throw budgetError('budgetLeaseLost');
        return this.repository.compareAndSwapLease(
          {
            id: row.id,
            token,
            state: 'UPLOADING',
            nextState: 'UPLOADING',
            values: { lease_until: new Date(this.now() + 120000) },
          },
          transaction,
        );
      });
    // Durable committed intent must exist before any PUT; not a callback assertion.
    try {
      await refresh();
    } catch {
      throw budgetError('budgetLeaseLost');
    }
    let heartbeatWork;
    let heartbeatFailure;
    const controller = new AbortController();
    const forward = () => controller.abort();
    signal?.addEventListener('abort', forward, { once: true });
    if (signal?.aborted) forward();
    const heartbeat = setInterval(async () => {
      if (heartbeatWork) return;
      heartbeatWork = refresh().catch(() => {
        heartbeatFailure = true;
        controller.abort();
      });
      try {
        await heartbeatWork;
      } finally {
        heartbeatWork = undefined;
      }
    }, 15000);
    try {
      await this.operation(
        (client) =>
          client.putObject(this.bucket, key, bytes, bytes.length, {
            'Content-Type': 'application/pdf',
          }),
        { signal: controller.signal },
      );
      const stat = await this.stat(proof, { signal: controller.signal });
      if (heartbeatFailure || !stat || Number(stat.size) !== bytes.length)
        throw budgetError('storageUnavailable');
      // No publication/attachment here. A later use case must revalidate grants,
      // revision and live lease under the principal transaction before attachment.
      return {
        size_bytes: String(bytes.length),
        sha256: proof.sha256,
        content_type: 'application/pdf',
      };
    } finally {
      clearInterval(heartbeat);
      await heartbeatWork;
      signal?.removeEventListener('abort', forward);
    }
  }
  async stat(row, options) {
    const key = this.target(row);
    return this.operation(async (client) => {
      try {
        return await client.statObject(this.bucket, key);
      } catch (error) {
        if (absent(error)) return null;
        throw error;
      }
    }, options);
  }
  async remove(row, options) {
    // This is an internal cleanup primitive, never a commercial delete command.
    // The worker additionally holds owner/object locks and checks both DB slots.
    if (row?.state !== 'CLEANING' || !row.lease_token)
      throw budgetError('budgetLeaseLost');
    const key = this.target(row);
    await this.operation(async (client) => {
      try {
        await client.removeObject(this.bucket, key);
      } catch (error) {
        if (!absent(error)) throw error;
      }
    }, options);
    if (await this.stat(row, options)) throw budgetError('storageUnavailable');
  }
  async get(row, { start, length, signal } = {}) {
    const key = this.target(row);
    if (row.state !== 'ATTACHED') throw budgetError('notFound');
    if (
      start !== undefined &&
      (!Number.isSafeInteger(start) ||
        start < 0 ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        start + length > Number(row.size_bytes))
    )
      throw budgetError('validation');
    if (this.streams >= 4) throw budgetError('resourceLimit');
    this.streams++;
    try {
      const stream = await this.operation(
        (client) =>
          start === undefined
            ? client.getObject(this.bucket, key)
            : client.getPartialObject(this.bucket, key, start, length),
        { signal, duration: this.streamMs, streaming: true },
      );
      stream.once('close', () => {
        this.streams--;
      });
      return stream; // caller must hold authorization/reference locks until close
    } catch (error) {
      this.streams--;
      throw error;
    }
  }
  async listPage({ after = '', limit = 25, signal } = {}) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 25 ||
      (after && !after.startsWith('budgets-pdf/'))
    )
      throw budgetError('validation');
    return this.operation(
      async (client) => {
        const stream = client.listObjectsV2(
          this.bucket,
          'budgets-pdf/',
          true,
          after,
        );
        const entries = [];
        const abort = () => stream.destroy(budgetError('storageUnavailable'));
        const operationSignal = operations.getStore();
        operationSignal.addEventListener('abort', abort, { once: true });
        try {
          for await (const item of stream) {
            if (!item.name?.startsWith('budgets-pdf/'))
              throw budgetError('storageUnavailable');
            entries.push(item);
            if (entries.length === limit) break;
          }
          return {
            entries,
            next: entries.length === limit ? entries.at(-1).name : '',
          };
        } finally {
          operationSignal.removeEventListener('abort', abort);
          stream.destroy();
        }
      },
      { signal },
    );
  }
}
