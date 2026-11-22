import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

// Service descriptor projected by a test-only adapter, NOT HTTP T037 evidence.
const moduleUrl = new URL(
  '../../../src/app/services/BudgetPdfStreamService.js',
  import.meta.url,
);
const options = {};
async function fixture() {
  const { BudgetPdfStreamService } = await import(moduleUrl);
  const id = randomUUID(),
    objectId = randomUUID(),
    clientId = randomUUID();
  const events = [];
  const row = {
    id,
    client_id: clientId,
    sector_id: randomUUID(),
    revision: '2',
    published_object_id: objectId,
    published_validity_date: '2020-01-01',
  };
  const object = {
    id: objectId,
    owner_budget_id: id,
    state: 'ATTACHED',
    size_bytes: '5',
    content_type: 'application/pdf',
    bucket: 'secret-bucket',
    object_key: 'secret-key',
  };
  const source = new PassThrough();
  const objects = {
    async transaction(fn) {
      events.push('begin');
      try {
        return await fn({});
      } finally {
        events.push('release');
      }
    },
    async lockObjects() {
      return [object];
    },
  };
  const authorization = {
    async authorizeOperation() {
      events.push('authorize');
    },
    async authorizeClientRead() {
      events.push('authorize');
    },
  };
  const budgets = {
    async findById() {
      return row;
    },
    async lockBudget() {
      events.push('lock');
      return row;
    },
  };
  const storage = {
    async stat() {
      return { size: 5 };
    },
    async get(current, range) {
      events.push({ range });
      assert.equal(current.id, objectId);
      return source;
    },
  };
  const service = new BudgetPdfStreamService({
    budgets,
    objects,
    authorization,
    storage,
  });
  const response = new PassThrough();
  const headers = {};
  const chunks = [];
  response.statusCode = 200;
  response.setHeader = (key, value) => {
    headers[key.toLowerCase()] = value;
  };
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.set = (key, value) => {
    response.setHeader(key, value);
    return response;
  };
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('error', () => {});
  const input = {
    id,
    actor: { id: clientId, type: 'client' },
  };
  const run = (extra = {}, signal) =>
    service.stream({ ...input, ...extra }, response, {
      signal,
      onReady(meta) {
        response.statusCode = meta.status;
        for (const [key, value] of Object.entries({
          'content-range': meta.contentRange,
          'cache-control': meta.cacheControl,
          vary: meta.vary,
          'x-content-type-options': meta.nosniff ? 'nosniff' : undefined,
          'content-security-policy': meta.contentSecurityPolicy,
          'content-type': meta.contentType,
          'content-disposition': `${meta.disposition}; filename="${meta.filename}"`,
        })) {
          if (value !== undefined) response.setHeader(key, value);
        }
      },
    });
  return {
    service,
    input,
    run,
    source,
    response,
    headers,
    chunks,
    events,
    row,
  };
}
test(
  'T033 each new request reauthorizes; current published only and locks held until end',
  options,
  async () => {
    const s = await fixture();
    const pending = s.run();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(s.events.includes('authorize'));
    assert.ok(s.events.includes('lock'));
    assert.ok(!s.events.includes('release'));
    s.source.end(Buffer.from('%PDF-'));
    await pending;
    assert.ok(s.events.includes('release'));
    const denied = await fixture();
    denied.service.authorization.authorizeClientRead = async () => {
      throw Object.assign(new Error(), { code: 'budgetNotFound' });
    };
    await assert.rejects(denied.run(), { status: 404 });
  },
);
test(
  'T033 single Range206 and exact Content-Range, no304 even with cache validators',
  options,
  async () => {
    const s = await fixture();
    s.source.end(Buffer.from('PDF'));
    await s.run({ range: 'bytes=1-3', ifNoneMatch: '*' });
    assert.equal(s.response.statusCode, 206);
    assert.equal(s.headers['content-range'], 'bytes 1-3/5');
    assert.equal(Buffer.concat(s.chunks).toString(), 'PDF');
  },
);
test(
  'T033 invalid, multiple and out-of-range416 without document bytes',
  options,
  async () => {
    for (const range of [
      'bytes=0-1,3-4',
      'bytes=9-',
      'bytes=no',
      'bytes=4-2',
    ]) {
      const s = await fixture();
      await s.run({ range });
      assert.equal(s.response.statusCode, 416);
      assert.equal(Buffer.concat(s.chunks).length, 0);
      assert.equal(s.headers['content-range'], 'bytes */5');
    }
  },
);
test(
  'T033 private security headers and UUID filename, no external URL or technical metadata',
  options,
  async () => {
    const s = await fixture();
    s.source.end(Buffer.from('%PDF-'));
    await s.run();
    assert.equal(s.headers['cache-control'], 'private,no-store,max-age=0');
    assert.match(s.headers.vary, /Cookie/i);
    assert.equal(s.headers['x-content-type-options'], 'nosniff');
    assert.match(s.headers['content-security-policy'], /sandbox/);
    assert.equal(s.headers['content-type'], 'application/pdf');
    assert.equal(
      s.headers['content-disposition'],
      `attachment; filename="${s.input.id}.pdf"`,
    );
    assert.doesNotMatch(
      JSON.stringify(s.headers),
      /secret-bucket|secret-key|https?:/,
    );
    assert.equal(s.headers.location, undefined);
  },
);
test('download-only service rejects all disposition selectors before storage', async () => {
  for (const disposition of ['inline', 'attachment']) {
    const s = await fixture();
    await assert.rejects(s.run({ disposition }), { code: 'validation' });
    assert.deepEqual(s.events, []);
  }
});
test(
  'T033 client cannot select pending/object; abort releases stream and connection',
  options,
  async () => {
    const s = await fixture();
    await assert.rejects(s.run({ slot: 'pending' }));
    const controller = new AbortController();
    const active = s.run({}, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await active.catch(() => {});
    assert.ok(s.source.destroyed);
    assert.ok(s.events.includes('release'));
  },
);
test(
  'T033 storage failure before headers503 and after bytes aborts without mixed JSON',
  options,
  async () => {
    const s = await fixture();
    s.service.storage.get = async () => {
      throw new Error('private credentials');
    };
    await assert.rejects(s.run(), { status: 503 });
    const live = await fixture();
    const active = live.run();
    await new Promise((resolve) => setImmediate(resolve));
    live.source.write('%PDF-');
    await new Promise((resolve) => setImmediate(resolve));
    live.source.destroy(new Error('private credentials'));
    await active.catch(() => {});
    assert.ok(live.response.destroyed);
    assert.doesNotMatch(
      Buffer.concat(live.chunks).toString(),
      /credentials|error/,
    );
    assert.ok(live.events.includes('release'));
  },
);
test(
  'T033 four concurrent streams maximum and 60s default deadline',
  options,
  async () => {
    const s = await fixture();
    assert.equal(s.service.timeoutMs, 60000);
    const fixtures = [
      s,
      ...(await Promise.all([fixture(), fixture(), fixture()])),
    ];
    const active = fixtures.map((f) => f.run().catch((e) => e));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(s.run(), { status: 429 });
    for (const f of fixtures) f.source.end('%PDF-');
    const results = await Promise.all(active);
    assert.ok(results.every((r) => !(r instanceof Error)));
  },
);
test(
  'T033 timeout aborts source and releases transaction (short injected test deadline)',
  options,
  async () => {
    const s = await fixture();
    s.service.timeoutMs = 20;
    await s.run().catch(() => {});
    assert.ok(s.source.destroyed);
    assert.ok(s.events.includes('release'));
  },
);
test('T036 truncated/oversized upstream fails closed; no fallback document', async () => {
  for (const bytes of ['%PDF', '%PDF-extra']) {
    const s = await fixture();
    s.source.end(bytes);
    await assert.rejects(s.run(), { code: 'storageUnavailable' });
    assert.equal(s.response.destroyed, bytes === '%PDF');
    assert.ok(s.events.includes('release'));
  }
});
test('T036 Range suffix/open/clamping, malformed and unsafe integers', async () => {
  const { budgetPdfRange } = await import(moduleUrl);
  assert.deepEqual(budgetPdfRange('bytes=-2', 5), {
    start: 3,
    length: 2,
    partial: true,
  });
  assert.deepEqual(budgetPdfRange('bytes=2-', 5), {
    start: 2,
    length: 3,
    partial: true,
  });
  assert.deepEqual(budgetPdfRange('bytes=0-999', 5), {
    start: 0,
    length: 5,
    partial: true,
  });
  for (const value of [
    'bytes=-0',
    'bytes=-',
    'bytes=9007199254740992-',
    'bytes=0-1,2-3',
    'bytes=5-',
  ])
    assert.equal(budgetPdfRange(value, 5), null);
});
test('T036 pre-aborted signal and untrusted clientId/key never reach storage', async () => {
  for (const extra of [
    { clientId: randomUUID() },
    { objectKey: 'external' },
    { documentId: randomUUID() },
  ]) {
    const s = await fixture();
    await assert.rejects(s.run(extra), { code: 'validation' });
    assert.equal(s.events.length, 0);
  }
  const s = await fixture(),
    c = new AbortController();
  c.abort();
  await assert.rejects(s.run({}, c.signal), { code: 'storageUnavailable' });
  assert.ok(!s.events.includes('authorize'));
});
test('T036 GET error before first bytes does not call onReady or destroy JSON-capable destination', async () => {
  const s = await fixture();
  let ready = false;
  const pending = s.service.stream(s.input, s.response, {
    onReady() {
      ready = true;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  s.source.destroy(new Error('technical details'));
  await assert.rejects(pending, { code: 'storageUnavailable' });
  assert.equal(ready, false);
  assert.equal(s.response.destroyed, false);
  assert.ok(s.events.includes('release'));
});
