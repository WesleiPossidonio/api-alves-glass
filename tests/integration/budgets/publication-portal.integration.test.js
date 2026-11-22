import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';
import { createHash, randomUUID } from 'node:crypto';
import Jwt from 'jsonwebtoken';
import authConfig from '../../../src/config/auth.js';
import AuthSession from '../../../src/app/models/AuthSession.js';
import User from '../../../src/app/models/User.js';
import { csrfTokenForSession } from '../../../src/app/services/sessionSecurity.js';
import { createBudgetPdfRouter } from '../../../src/app/meddleawares/budgetPdfHttp.js';
import { BudgetPdfController } from '../../../src/app/controllers/BudgetPdfController.js';
import { ClientBudgetPdfController } from '../../../src/app/controllers/ClientBudgetPdfController.js';
import { BudgetPdfPublishService } from '../../../src/app/services/BudgetPdfPublishService.js';
import { BudgetPdfReadService } from '../../../src/app/services/BudgetPdfReadService.js';
import { ClientBudgetPdfService } from '../../../src/app/services/ClientBudgetPdfService.js';
import { BudgetPdfStreamService } from '../../../src/app/services/BudgetPdfStreamService.js';
import { matrixFixture } from '../../support/budgets/matrix-fixture.js';

test('T038 actual HTTP: publication, portal ownership, revocation, hash and Range over PG17/MinIO', async (t) => {
  const f = await matrixFixture();
  f.db.options.define.underscored = true;
  AuthSession.init(f.db);
  User.init(f.db);
  const member = await f.user();
  await f.rows(
    'INSERT INTO public.user_sectors(user_id,sector_id,granted_by,created_at) VALUES (:user,:sector,:admin,now())',
    { user: member, sector: f.sectorId, admin: f.creator },
  );
  await f.rows(
    "INSERT INTO public.budget_commercial_permissions(user_id,sector_id,operation,granted_by) VALUES (:user,:sector,'PUBLISH',:admin)",
    { user: member, sector: f.sectorId, admin: f.creator },
  );

  const services = {
    budgets: f.budgets,
    objects: f.objects,
    authorization: f.authorization,
    storage: f.storage,
  };
  const cursorSecret = 'T037-http-integration-cursor-secret-32-bytes';
  const stream = new BudgetPdfStreamService(services);
  const adminController = new BudgetPdfController({
    read: new BudgetPdfReadService({ ...services, cursorSecret }),
    publish: new BudgetPdfPublishService(services),
    stream,
  });
  const clientController = new ClientBudgetPdfController({
    read: new ClientBudgetPdfService({ ...services, cursorSecret }),
    stream,
  });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    '/client/budgets',
    createBudgetPdfRouter({ transport: clientController, client: true }),
  );
  app.use('/budgets', createBudgetPdfRouter({ transport: adminController }));
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await f.db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function session(actorId, type) {
    const sid = randomUUID();
    const csrf = csrfTokenForSession(sid);
    await AuthSession.create({
      id: sid,
      actor_type: type,
      user_id: type === 'user' ? actorId : null,
      client_id: type === 'client' ? actorId : null,
      expires_at: new Date(Date.now() + 60_000),
    });
    const access = Jwt.sign(
      { sub: actorId, sid, actor_type: type },
      authConfig.secret,
      { expiresIn: 60 },
    );
    return {
      sid,
      csrf,
      cookie: `access_token=${access}; csrf_token=${csrf}`,
      headers: { cookie: `access_token=${access}; csrf_token=${csrf}` },
      mutation: {
        cookie: `access_token=${access}; csrf_token=${csrf}`,
        origin: 'http://localhost',
        'x-csrf-token': csrf,
        'content-type': 'application/json',
      },
    };
  }
  const userSession = await session(member, 'user');
  const ownerSession = await session(f.clientId, 'client');
  const otherClient = await f.client();
  const otherSession = await session(otherClient, 'client');

  const privateCandidate = await f.attached({ date: '2020-01-01' });
  await f.rows(
    'UPDATE public.budget_pdf_objects SET lease_token=NULL,lease_until=NULL WHERE id=:id',
    { id: privateCandidate.proof.id },
  );
  const privateId = privateCandidate.proof.owner_budget_id;
  const pendingDocumentId = privateCandidate.proof.id;
  const privateResponse = await fetch(`${base}/client/budgets/${privateId}`, {
    headers: ownerSession.headers,
  });
  assert.equal(privateResponse.status, 404);
  const privatePdf = await fetch(`${base}/client/budgets/${privateId}/pdf`, {
    headers: ownerSession.headers,
  });
  assert.equal(privatePdf.status, 404);
  const foreignBefore = await fetch(`${base}/client/budgets/${privateId}`, {
    headers: otherSession.headers,
  });
  assert.equal(foreignBefore.status, 404);
  const missingDetail = await fetch(`${base}/client/budgets/${randomUUID()}`, {
    headers: ownerSession.headers,
  });
  assert.equal(missingDetail.status, 404);
  assert.equal(
    (await missingDetail.json()).error.code,
    (await foreignBefore.clone().json()).error.code,
  );

  const resourceTag = `"budget-${privateId}-1"`;
  const noOriginHeaders = { ...userSession.mutation };
  delete noOriginHeaders.origin;
  const withoutOrigin = await fetch(`${base}/budgets/${privateId}/publish`, {
    method: 'POST',
    headers: noOriginHeaders,
    body: JSON.stringify({ pendingDocumentId }),
  });
  assert.equal(withoutOrigin.status, 403);
  const badCsrf = await fetch(`${base}/budgets/${privateId}/publish`, {
    method: 'POST',
    headers: { ...userSession.mutation, 'x-csrf-token': 'invalid' },
    body: JSON.stringify({ pendingDocumentId }),
  });
  assert.equal(badCsrf.status, 403);
  const missingRevision = await fetch(`${base}/budgets/${privateId}/publish`, {
    method: 'POST',
    headers: userSession.mutation,
    body: JSON.stringify({ pendingDocumentId }),
  });
  assert.equal(missingRevision.status, 428);
  const staleRevision = await fetch(`${base}/budgets/${privateId}/publish`, {
    method: 'POST',
    headers: { ...userSession.mutation, 'if-match': `"budget-${privateId}-9"` },
    body: JSON.stringify({ pendingDocumentId }),
  });
  assert.equal(staleRevision.status, 412);

  const published = await fetch(`${base}/budgets/${privateId}/publish`, {
    method: 'POST',
    headers: { ...userSession.mutation, 'if-match': resourceTag },
    body: JSON.stringify({ pendingDocumentId }),
  });
  assert.equal(published.status, 200, await published.clone().text());
  assert.equal(published.headers.get('etag'), `"budget-${privateId}-2"`);
  assert.deepEqual(await published.json(), { id: privateId, revision: '2' });
  const publishedPair = await f.objects.transaction((transaction) =>
    f.budgets.findById(privateId, transaction),
  );
  const publishedHash = privateCandidate.proof.sha256;

  const ownerDetail = await fetch(`${base}/client/budgets/${privateId}`, {
    headers: ownerSession.headers,
  });
  assert.equal(ownerDetail.status, 200);
  assert.equal((await ownerDetail.json()).expired, true);
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Pacific/Honolulu';
  try {
    const ownerDetailOtherTimezone = await fetch(
      `${base}/client/budgets/${privateId}`,
      { headers: ownerSession.headers },
    );
    assert.equal(ownerDetailOtherTimezone.status, 200);
    assert.equal((await ownerDetailOtherTimezone.json()).expired, true);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
  const foreignAfter = await fetch(`${base}/client/budgets/${privateId}`, {
    headers: otherSession.headers,
  });
  assert.equal(foreignAfter.status, 404);
  const ownerPdf = await fetch(`${base}/client/budgets/${privateId}/pdf`, {
    headers: ownerSession.headers,
  });
  assert.equal(ownerPdf.status, 200);
  assert.equal(ownerPdf.headers.get('content-type'), 'application/pdf');
  assert.equal(
    ownerPdf.headers.get('content-length'),
    String(privateCandidate.proof.size_bytes),
  );
  assert.match(
    ownerPdf.headers.get('content-disposition'),
    /^attachment; filename="[0-9a-f-]+\.pdf"$/i,
  );
  assert.equal(
    ownerPdf.headers.get('cache-control'),
    'private,no-store,max-age=0',
  );
  assert.equal(ownerPdf.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ownerPdf.headers.get('content-security-policy'), 'sandbox');
  assert.match(ownerPdf.headers.get('vary'), /Cookie/i);
  const fullBytes = Buffer.from(await ownerPdf.arrayBuffer());
  assert.equal(fullBytes.length, Number(privateCandidate.proof.size_bytes));
  assert.equal(
    createHash('sha256').update(fullBytes).digest('hex'),
    privateCandidate.proof.sha256,
    'HTTP body bytes preserve the uploaded PDF SHA-256',
  );
  const forcedInline = await fetch(
    `${base}/client/budgets/${privateId}/pdf?disposition=inline`,
    { headers: ownerSession.headers },
  );
  assert.equal(forcedInline.status, 400);
  await forcedInline.arrayBuffer();
  for (const [path, headers, status] of [
    [`/client/budgets/${privateId}/pdf`, {}, 401],
    [`/client/budgets/${privateId}/pdf`, otherSession.headers, 404],
    [
      `/budgets/${privateId}/pdf?slot=published&disposition=inline`,
      userSession.headers,
      400,
    ],
    [
      `/client/budgets/${privateId}/pdf?disposition=attachment`,
      ownerSession.headers,
      400,
    ],
    [
      `/client/budgets/${privateId}/pdf?response-content-disposition=inline`,
      ownerSession.headers,
      400,
    ],
  ]) {
    const denied = await fetch(`${base}${path}`, { headers });
    assert.equal(denied.status, status);
    assert.equal(denied.headers.get('location'), null);
    await denied.arrayBuffer();
  }
  const headerOverride = await fetch(
    `${base}/client/budgets/${privateId}/pdf`,
    {
      headers: {
        ...ownerSession.headers,
        'content-disposition': 'inline',
        accept: 'application/pdf',
      },
    },
  );
  assert.equal(headerOverride.status, 200);
  assert.match(
    headerOverride.headers.get('content-disposition'),
    /^attachment;/,
  );
  assert.equal(headerOverride.headers.get('location'), null);
  assert.deepEqual(Buffer.from(await headerOverride.arrayBuffer()), fullBytes);
  // Prepare a distinct pending pair using the existing foundation fixture, not US3.
  const next = await f.intent({
    owner: privateId,
    revision: '2',
    date: '2030-01-01',
    bytes: Buffer.concat([buildPdf(), Buffer.from('\n% distinct candidate\n')]),
  });
  await f.storage.upload(next.proof, next.token);
  await f.tx(async (tx) => {
    await f.budgets.lockBudget(privateId, tx);
    await f.objects.lockObjects([next.proof.id], tx);
    await f.ready(next, tx);
    await f.budgets.compareAndSwap(
      privateId,
      '2',
      { pending_object_id: next.proof.id, pending_validity_date: next.date },
      tx,
    );
    await f.rows(
      "UPDATE public.budget_pdf_objects SET state='ATTACHED',lease_token=NULL,lease_until=NULL WHERE id=:id",
      { id: next.proof.id },
      tx,
    );
  });
  let wroteCleanup = false;
  const normalPublish = adminController.publishService;
  adminController.publishService = new BudgetPdfPublishService({
    ...services,
    objects: new Proxy(f.objects, {
      get(target, key) {
        if (key === 'enqueueDetached')
          return async (...args) => {
            await target.enqueueDetached(...args);
            wroteCleanup = true;
            throw new Error(
              'intentional test-only failure after publication writes',
            );
          };
        return typeof target[key] === 'function'
          ? target[key].bind(target)
          : target[key];
      },
    }),
  });
  try {
    const failed = await fetch(`${base}/budgets/${privateId}/publish`, {
      method: 'POST',
      headers: {
        ...userSession.mutation,
        'if-match': `"budget-${privateId}-3"`,
      },
      body: JSON.stringify({ pendingDocumentId: next.proof.id }),
    });
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error.code, 'storageUnavailable');
    assert.equal(wroteCleanup, true);
  } finally {
    adminController.publishService = normalPublish;
  }
  const afterRollback = await f.objects.transaction((transaction) =>
    f.budgets.findById(privateId, transaction),
  );
  assert.equal(
    afterRollback.published_object_id,
    publishedPair.published_object_id,
  );
  assert.equal(
    afterRollback.published_validity_date,
    publishedPair.published_validity_date,
  );
  assert.equal(String(afterRollback.revision), '3');
  assert.equal(afterRollback.pending_object_id, next.proof.id);
  assert.equal(
    (await f.ObjectModel.findByPk(pendingDocumentId)).state,
    'ATTACHED',
  );
  assert.notEqual(next.proof.sha256, publishedHash);

  async function verifyPair(url) {
    const detail = await fetch(`${url}/client/budgets/${privateId}`, {
      headers: ownerSession.headers,
    });
    assert.equal(detail.status, 200);
    assert.equal(
      (await detail.json()).validityDate,
      publishedPair.published_validity_date,
    );
    const pdf = await fetch(`${url}/client/budgets/${privateId}/pdf`, {
      headers: ownerSession.headers,
    });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-disposition'), /^attachment;/);
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(await pdf.arrayBuffer()))
        .digest('hex'),
      publishedHash,
    );
  }
  await verifyPair(base);
  let priorPid;
  for (let round = 0; round < 2; round++) {
    const child = fork(
      new URL('../../support/budgets/portal-http-child.js', import.meta.url),
      [],
      {
        env: { ...process.env, TZ: round ? 'Pacific/Honolulu' : 'UTC' },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      },
    );
    const exited = once(child, 'exit');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
    try {
      const ready = await Promise.race([
        once(child, 'message').then(([msg]) => msg),
        exited.then(() => {
          throw new Error('HTTP_CHILD_EXITED_BEFORE_READY');
        }),
      ]);
      assert.notEqual(ready.pid, priorPid);
      priorPid = ready.pid;
      await verifyPair(`http://127.0.0.1:${ready.port}`);
      child.kill(round ? 'SIGTERM' : 'SIGKILL');
      const [code, signal] = await exited;
      if (round) assert.equal(code, 0);
      else assert.equal(signal, 'SIGKILL');
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  }
  const restartedPair = await f.objects.transaction((transaction) =>
    f.budgets.findById(privateId, transaction),
  );
  assert.equal(
    restartedPair.published_object_id,
    publishedPair.published_object_id,
  );
  assert.equal(
    restartedPair.published_validity_date,
    publishedPair.published_validity_date,
  );
  const range = await fetch(`${base}/client/budgets/${privateId}/pdf`, {
    headers: { ...ownerSession.headers, range: 'bytes=0-7' },
  });
  assert.equal(range.status, 206);
  assert.equal(
    range.headers.get('content-range'),
    `bytes 0-7/${fullBytes.length}`,
  );
  assert.equal(range.headers.get('content-length'), '8');
  assert.deepEqual(
    Buffer.from(await range.arrayBuffer()),
    fullBytes.subarray(0, 8),
  );
  const unsatisfiable = await fetch(`${base}/client/budgets/${privateId}/pdf`, {
    headers: { ...ownerSession.headers, range: `bytes=${fullBytes.length}-` },
  });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(
    unsatisfiable.headers.get('content-range'),
    `bytes */${fullBytes.length}`,
  );
  assert.equal((await unsatisfiable.arrayBuffer()).byteLength, 0);

  // Each request re-resolves the published slot and revalidates live session
  // ownership. A previously valid URL/range never becomes a bearer capability.
  const previouslyIssuedRangeUrl = await fetch(
    `${base}/client/budgets/${privateId}/pdf`,
    { headers: { ...ownerSession.headers, range: 'bytes=0-7' } },
  );
  assert.equal(previouslyIssuedRangeUrl.status, 206);
  assert.deepEqual(
    Buffer.from(await previouslyIssuedRangeUrl.arrayBuffer()),
    fullBytes.subarray(0, 8),
  );

  await AuthSession.destroy({ where: { id: ownerSession.sid } });
  const revokedSessionRange = await fetch(
    `${base}/client/budgets/${privateId}/pdf`,
    { headers: { ...ownerSession.headers, range: 'bytes=0-7' } },
  );
  assert.equal(revokedSessionRange.status, 401);
  await revokedSessionRange.arrayBuffer();

  const renewedOwnerSession = await session(f.clientId, 'client');
  const validAfterSessionRenewal = await fetch(
    `${base}/client/budgets/${privateId}/pdf`,
    { headers: renewedOwnerSession.headers },
  );
  assert.equal(validAfterSessionRenewal.status, 200);
  assert.deepEqual(
    Buffer.from(await validAfterSessionRenewal.arrayBuffer()),
    fullBytes,
  );

  await f.rows(
    'DELETE FROM public.user_sectors WHERE user_id=:user AND sector_id=:sector',
    {
      user: member,
      sector: f.sectorId,
    },
  );
  const revokedMembershipPublish = await fetch(
    `${base}/budgets/${privateId}/publish`,
    {
      method: 'POST',
      headers: {
        ...userSession.mutation,
        'if-match': `"budget-${privateId}-2"`,
      },
      body: JSON.stringify({ pendingDocumentId }),
    },
  );
  assert.equal(revokedMembershipPublish.status, 403);
  await revokedMembershipPublish.arrayBuffer();

  const currentPublishedRange = await fetch(
    `${base}/client/budgets/${privateId}/pdf`,
    {
      headers: { ...renewedOwnerSession.headers, range: 'bytes=0-7' },
    },
  );
  assert.equal(currentPublishedRange.status, 206);
  assert.deepEqual(
    Buffer.from(await currentPublishedRange.arrayBuffer()),
    fullBytes.subarray(0, 8),
  );

  const clientCannotChooseSlot = await fetch(
    `${base}/client/budgets/${privateId}/pdf?slot=pending`,
    {
      headers: renewedOwnerSession.headers,
    },
  );
  assert.equal(clientCannotChooseSlot.status, 400);
});
