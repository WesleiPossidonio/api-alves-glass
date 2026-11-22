import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  BudgetPdfStorageServiceClient,
  budgetObjectKey,
} from '../../../src/app/services/BudgetPdfStorageService.js';

const owner = '12345678-1234-4234-8234-123456789abc';
const bytes = Buffer.from('%PDF-synthetic unit bytes');
function setup() {
  let row;
  let stored;
  let puts = 0;
  const repository = {
    transaction: async (fn) => fn({}),
    lockOwned: async () => row,
    compareAndSwapLease: async ({ token }) => {
      if (token !== row?.lease_token) throw new Error('stale');
      return row;
    },
  };
  const client = {
    putObject: async (bucket, key, input, length, metadata) => {
      puts++;
      assert.equal(metadata['Content-Type'], 'application/pdf');
      assert.equal(length, input.length);
      stored = Buffer.from(input);
    },
    statObject: async () => {
      if (!stored) throw Object.assign(new Error(), { code: 'NoSuchKey' });
      return { size: stored.length };
    },
    removeObject: async () => {
      stored = undefined;
    },
    getObject: async () => Readable.from([stored]),
    getPartialObject: async (_, key, start, length) =>
      Readable.from([stored.subarray(start, start + length)]),
    listObjectsV2: (bucket, prefix, recursive, after) => {
      assert.equal(prefix, 'budgets-pdf/');
      assert.equal(recursive, true);
      return Readable.from([
        { name: budgetObjectKey(owner, owner), lastModified: new Date(0) },
      ]);
    },
  };
  const service = new BudgetPdfStorageServiceClient({
    client,
    env: {
      MINIO_PRIVATE_BUCKET: 'private-pdfs',
      MINIO_PUBLIC_BUCKET: 'images',
    },
    repository,
    runtime: { ensureUploadsReady: async () => {} },
    validator: {
      validate: async (input) => ({
        bytes: Buffer.from(input),
        sizeBytes: input.length,
        sha256: createHash('sha256').update(input).digest('hex'),
      }),
    },
  });
  return {
    service,
    repository,
    client,
    setRow: (value) => {
      row = value;
    },
    puts: () => puts,
    stored: () => stored,
  };
}
test('T017 validation proof, durable intent, immutable private target and exact bytes', async () => {
  const s = setup();
  const input = Buffer.from(bytes);
  const proof = await s.service.prepare(input, owner);
  input.fill(0);
  await assert.rejects(s.service.upload(proof, 'token'), {
    code: 'budgetLeaseLost',
  });
  assert.equal(s.puts(), 0);
  const next = await s.service.prepare(bytes, owner);
  s.setRow({ ...next, state: 'UPLOADING', lease_token: 'token' });
  const result = await s.service.upload(next, 'token');
  assert.equal(result.size_bytes, String(bytes.length));
  assert.deepEqual(s.stored(), bytes);
  assert.equal(s.puts(), 1);
  await assert.rejects(s.service.upload(next, 'token'), {
    code: 'validatorFailed',
  });
  await assert.rejects(s.service.upload({ ...next }, 'token'), {
    code: 'validatorFailed',
  });
  assert.notEqual(proof.object_key, next.object_key);
});
test('T017 invalid config, qpdf failure and stale token never PUT', async () => {
  const s = setup();
  s.service.env.MINIO_PRIVATE_BUCKET = 'images';
  await assert.rejects(s.service.prepare(bytes, owner), {
    code: 'storageUnavailable',
  });
  s.service.env.MINIO_PRIVATE_BUCKET = 'private-pdfs';
  s.service.validator.validate = async () => {
    throw Object.assign(new Error(), { code: 'invalidPdf' });
  };
  await assert.rejects(s.service.prepare(bytes, owner), { code: 'invalidPdf' });
  assert.equal(s.puts(), 0);
});
test('T017 expired/fenced intent cannot reach PUT; private remove requires confirmed absence', async () => {
  const s = setup();
  const proof = await s.service.prepare(bytes, owner);
  s.setRow({ ...proof, lease_token: 'new-token' });
  await assert.rejects(s.service.upload(proof, 'old-token'), {
    code: 'budgetLeaseLost',
  });
  assert.equal(s.puts(), 0);
  const row = { ...proof, state: 'CLEANING', lease_token: 'new-token' };
  s.client.removeObject = async () => {};
  s.client.statObject = async () => ({ size: 1 });
  await assert.rejects(s.service.remove(row), { code: 'storageUnavailable' });
});
test('T017 abort destroys private stream and releases concurrency reservation', async () => {
  const s = setup();
  const proof = await s.service.prepare(bytes, owner);
  const row = { ...proof, state: 'ATTACHED' };
  const source = new Readable({ read() {} });
  s.client.getObject = async () => source;
  const controller = new AbortController();
  const stream = await s.service.get(row, { signal: controller.signal });
  const closed = new Promise((resolve) => stream.once('close', resolve));
  controller.abort();
  await closed;
  assert.equal(stream.destroyed, true);
  assert.equal(s.service.streams, 0);
});
test('T017 failed PUT/stat/size and network timeout never confirm', async () => {
  for (const mode of ['put', 'stat', 'size', 'timeout']) {
    const s = setup();
    const proof = await s.service.prepare(bytes, owner);
    s.setRow({ ...proof, lease_token: 'token' });
    if (mode === 'put')
      s.client.putObject = async () => {
        throw new Error('secret');
      };
    if (mode === 'stat')
      s.client.statObject = async () => {
        throw new Error('secret');
      };
    if (mode === 'size') s.client.statObject = async () => ({ size: 1 });
    if (mode === 'timeout') {
      s.service.timeoutMs = 5;
      s.client.putObject = () => new Promise(() => {});
    }
    await assert.rejects(s.service.upload(proof, 'token'), {
      code: 'storageUnavailable',
      message: 'storageUnavailable',
    });
  }
});
test('T017 private stream/range, abort, idempotent remove and prefix-only paging', async () => {
  const s = setup();
  const proof = await s.service.prepare(bytes, owner);
  s.setRow({ ...proof, lease_token: 'token' });
  await s.service.upload(proof, 'token');
  const row = { ...proof, state: 'ATTACHED' };
  const stream = await s.service.get(row, { start: 0, length: 5 });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), '%PDF-');
  await assert.rejects(s.service.get({ ...row, state: 'UPLOADING' }), {
    code: 'notFound',
  });
  await assert.rejects(s.service.get(row, { start: -1, length: 5 }), {
    code: 'validation',
  });
  await assert.rejects(s.service.stat({ ...row, object_key: 'foreign/key' }), {
    code: 'storageUnavailable',
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(s.service.stat(row, { signal: controller.signal }), {
    code: 'storageUnavailable',
  });
  await assert.rejects(s.service.remove(row), { code: 'budgetLeaseLost' });
  const cleaning = { ...row, state: 'CLEANING', lease_token: 'token' };
  await s.service.remove(cleaning);
  await s.service.remove(cleaning);
  const page = await s.service.listPage({ limit: 1 });
  assert.equal(page.next, budgetObjectKey(owner, owner));
  await assert.rejects(s.service.listPage({ after: 'other-prefix/' }), {
    code: 'validation',
  });
});
