import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import Jwt from 'jsonwebtoken';
import authConfig from '../../../src/config/auth.js';
import { csrfTokenForSession } from '../../../src/app/services/sessionSecurity.js';
import { createBudgetPdfRouter } from '../../../src/app/meddleawares/budgetPdfHttp.js';
import { BudgetPdfController } from '../../../src/app/controllers/BudgetPdfController.js';
import { budgetError } from '../../../src/app/services/BudgetContractService.js';

const pdf = Buffer.from('%PDF-http-test');

async function httpFixture(t, { streamError, filename } = {}) {
  const calls = [];
  const userId = randomUUID();
  const clientId = randomUUID();
  const budgetId = randomUUID();
  const sidUser = randomUUID();
  const sidClient = randomUUID();
  const sessions = new Map([
    [
      sidUser,
      {
        actor_type: 'user',
        user_id: userId,
        client_id: null,
        expires_at: new Date(Date.now() + 60_000),
      },
    ],
    [
      sidClient,
      {
        actor_type: 'client',
        user_id: null,
        client_id: clientId,
        expires_at: new Date(Date.now() + 60_000),
      },
    ],
  ]);
  const originalFind = (
    await import('../../../src/app/repositories/AuthSessionRepository.js')
  ).default.findActiveById;
  const repository = (
    await import('../../../src/app/repositories/AuthSessionRepository.js')
  ).default;
  const users = (
    await import('../../../src/app/repositories/UserRepository.js')
  ).default;
  const originalUserFind = users.findById;
  repository.findActiveById = async (id) => sessions.get(id) ?? null;
  users.findById = async (id) => ({ id, role: 'user' });
  t.after(() => {
    repository.findActiveById = originalFind;
    users.findById = originalUserFind;
  });

  const token = (id, sid, actor_type) =>
    Jwt.sign({ sub: id, sid, actor_type }, authConfig.secret, {
      expiresIn: '1m',
    });
  const cookie = (id, sid, actor_type) =>
    `access_token=${token(id, sid, actor_type)}; csrf_token=${csrfTokenForSession(sid)}`;
  const descriptor = (status, range) => ({
    status,
    size: pdf.length,
    length:
      status === 416 ? 0 : range ? range.end - range.start + 1 : pdf.length,
    contentRange:
      status === 206
        ? `bytes ${range.start}-${range.end}/${pdf.length}`
        : status === 416
          ? `bytes */${pdf.length}`
          : undefined,
    contentType: 'application/pdf',
    disposition: 'attachment',
    filename: filename ?? `${budgetId}.pdf`,
    cacheControl: 'private,no-store,max-age=0',
    contentSecurityPolicy: 'sandbox',
    acceptRanges: 'bytes',
  });
  const stream = {
    async stream(input, destination, { onReady }) {
      calls.push({ kind: 'stream', input });
      const range = input.range ? { start: 0, end: 3 } : undefined;
      const status =
        input.range === 'bytes=999-' ? 416 : input.range ? 206 : 200;
      if (streamError === 'before')
        throw Object.assign(new Error('storage secret'), {
          code: 'storageUnavailable',
        });
      await onReady(descriptor(status, range));
      if (status === 416) {
        destination.end();
        return;
      }
      if (streamError === 'after') {
        destination.write(pdf.subarray(0, 4));
        await new Promise((resolve) => setImmediate(resolve));
        destination.destroy(
          Object.assign(new Error('storage secret'), {
            code: 'storageUnavailable',
          }),
        );
        return;
      }
      destination.end(status === 206 ? pdf.subarray(0, 4) : pdf);
    },
  };
  const internal = new BudgetPdfController({
    create: {},
    read: {
      cursors: {},
      cursorSecret: 'unit-only-test-secret-value-longer-than-32-bytes',
    },
    stream,
    publish: {
      async publish(id, body, actor, { ifMatch }) {
        calls.push({ kind: 'publish', id, body, actor, ifMatch });
        if (!ifMatch) throw budgetError('revisionRequired');
        if (ifMatch !== `"budget-${id}-1"`)
          throw budgetError('revisionMismatch');
        return { id, revision: '2' };
      },
    },
  });
  Object.assign(internal, {
    async store(_request, response) {
      return response.status(201).json({ id: budgetId });
    },
    async publishTransport(request, response) {
      calls.push({ kind: 'publish', request });
      return response
        .set('ETag', `"budget-${request.params.id}-2"`)
        .json({ id: request.params.id, revision: '2' });
    },
    async index(_request, response) {
      return response.json({ items: [], nextCursor: null });
    },
    async show(_request, response) {
      return response.json({ id: budgetId });
    },
    async pdf(request, response) {
      const { streamBudgetHttp } = await import(
        '../../../src/app/controllers/BudgetPdfController.js'
      );
      return streamBudgetHttp(stream, request, response, {
        id: request.userId,
        type: request.actorType,
      });
    },
  });
  const client = {
    async index(_request, response) {
      return response.json({ items: [], nextCursor: null });
    },
    async show(_request, response) {
      return response.status(404).json({ error: { code: 'budgetNotFound' } });
    },
    async pdf(request, response) {
      const { streamBudgetHttp } = await import(
        '../../../src/app/controllers/BudgetPdfController.js'
      );
      return streamBudgetHttp(
        stream,
        request,
        response,
        { id: request.userId, type: request.actorType },
        true,
      );
    },
  };
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((request, _response, next) => {
    request._testPath = request.originalUrl;
    next();
  });
  app.use(
    '/client/budgets',
    createBudgetPdfRouter({ transport: client, client: true }),
  );
  app.use(
    '/budgets',
    createBudgetPdfRouter({ transport: internal, client: false }),
  );
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = (kind = 'user', overrides = {}) => {
    const sid = kind === 'user' ? sidUser : sidClient;
    const id = kind === 'user' ? userId : clientId;
    return {
      cookie: cookie(id, sid, kind),
      origin: 'http://localhost',
      'x-csrf-token': csrfTokenForSession(sid),
      ...overrides,
    };
  };
  return { base, calls, userId, clientId, budgetId, headers };
}

test('US2 HTTP transport paths', async (t) => {
  await t.test(
    'publication requires real user session, Origin, CSRF and If-Match; actor is session-derived',
    async (t) => {
      const f = await httpFixture(t);
      const id = f.budgetId;
      const good = await fetch(`${f.base}/budgets/${id}/publish`, {
        method: 'POST',
        headers: {
          ...f.headers(),
          'content-type': 'application/json',
          'if-match': `"budget-${id}-1"`,
        },
        body: JSON.stringify({ pendingDocumentId: randomUUID() }),
      });
      assert.equal(good.status, 200, await good.clone().text());
      assert.equal(good.headers.get('etag'), `"budget-${id}-2"`);
      assert.equal(f.calls.at(-1).actor.id, f.userId);
      assert.equal(f.calls.at(-1).ifMatch, `"budget-${id}-1"`);
      for (const [ifMatch, status, code] of [
        [undefined, 428, 'revisionRequired'],
        [`"budget-${id}-0"`, 412, 'revisionMismatch'],
      ]) {
        const response = await fetch(`${f.base}/budgets/${id}/publish`, {
          method: 'POST',
          headers: {
            ...f.headers(),
            'content-type': 'application/json',
            ...(ifMatch ? { 'if-match': ifMatch } : {}),
          },
          body: JSON.stringify({ pendingDocumentId: randomUUID() }),
        });
        assert.equal(response.status, status);
        assert.equal((await response.json()).error.code, code);
      }
      for (const headers of [
        { ...f.headers(), 'x-csrf-token': 'wrong' },
        { ...f.headers(), origin: 'https://untrusted.invalid' },
        { ...f.headers('client') },
      ]) {
        const before = f.calls.length;
        const result = await fetch(`${f.base}/budgets/${id}/publish`, {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/json',
            'if-match': `"budget-${id}-1"`,
          },
          body: JSON.stringify({ pendingDocumentId: randomUUID() }),
        });
        assert.ok([401, 403].includes(result.status));
        assert.equal(f.calls.length, before);
      }
    },
  );

  await t.test(
    'client and internal PDF routes enforce distinct session types and emit 200/206/416 headers',
    async (t) => {
      const f = await httpFixture(t);
      const full = await fetch(`${f.base}/client/budgets/${f.budgetId}/pdf`, {
        headers: f.headers('client'),
      });
      assert.equal(full.status, 200);
      assert.equal(full.headers.get('content-type'), 'application/pdf');
      assert.equal(full.headers.get('content-length'), String(pdf.length));
      assert.equal(
        full.headers.get('content-disposition'),
        `attachment; filename="${f.budgetId}.pdf"`,
      );
      assert.equal(
        full.headers.get('cache-control'),
        'private,no-store,max-age=0',
      );
      assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(full.headers.get('content-security-policy'), 'sandbox');
      assert.match(full.headers.get('vary'), /Cookie/i);
      assert.deepEqual(Buffer.from(await full.arrayBuffer()), pdf);
      const partial = await fetch(
        `${f.base}/client/budgets/${f.budgetId}/pdf`,
        { headers: { ...f.headers('client'), range: 'bytes=0-3' } },
      );
      assert.equal(partial.status, 206);
      assert.equal(
        partial.headers.get('content-range'),
        `bytes 0-3/${pdf.length}`,
      );
      assert.equal(partial.headers.get('content-length'), '4');
      assert.equal((await partial.arrayBuffer()).byteLength, 4);
      const invalid = await fetch(
        `${f.base}/client/budgets/${f.budgetId}/pdf`,
        { headers: { ...f.headers('client'), range: 'bytes=999-' } },
      );
      assert.equal(invalid.status, 416);
      assert.equal(
        invalid.headers.get('content-range'),
        `bytes */${pdf.length}`,
      );
      assert.equal((await invalid.arrayBuffer()).byteLength, 0);
      const cross = await fetch(`${f.base}/client/budgets/${f.budgetId}/pdf`, {
        headers: f.headers('user'),
      });
      assert.equal(cross.status, 403);
      const internal = await fetch(
        `${f.base}/budgets/${f.budgetId}/pdf?slot=pending`,
        { headers: f.headers('user') },
      );
      assert.equal(internal.status, 200);
      assert.equal(f.calls.at(-1).input.slot, 'pending');
      const clientCannotSelectSlot = await fetch(
        `${f.base}/client/budgets/${f.budgetId}/pdf?slot=pending`,
        { headers: f.headers('client') },
      );
      assert.equal(clientCannotSelectSlot.status, 400);
      const clientCannotForceInline = await fetch(
        `${f.base}/client/budgets/${f.budgetId}/pdf?disposition=inline`,
        { headers: f.headers('client') },
      );
      assert.equal(clientCannotForceInline.status, 400);
      assert.equal(f.calls.at(-1).kind, 'stream');
    },
  );

  await t.test(
    'sanitizes pre-byte errors and aborts post-header failures without JSON or header mutation',
    async (t) => {
      const before = await httpFixture(t, { streamError: 'before' });
      const failed = await fetch(
        `${before.base}/client/budgets/${before.budgetId}/pdf`,
        { headers: before.headers('client') },
      );
      assert.equal(failed.status, 503);
      assert.equal((await failed.json()).error.code, 'storageUnavailable');
      const after = await httpFixture(t, { streamError: 'after' });
      const controller = new AbortController();
      const response = await fetch(
        `${after.base}/client/budgets/${after.budgetId}/pdf`,
        { headers: after.headers('client'), signal: controller.signal },
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      await assert.rejects(response.arrayBuffer());
    },
  );

  await t.test(
    'rejects unsafe delivery filename before committing headers',
    async (t) => {
      const f = await httpFixture(t, {
        filename: `${randomUUID()}\r\nX-Leak: yes.pdf`,
      });
      const result = await fetch(`${f.base}/client/budgets/${f.budgetId}/pdf`, {
        headers: f.headers('client'),
      });
      assert.equal(result.status, 503);
      assert.equal(result.headers.get('x-leak'), null);
    },
  );
});
