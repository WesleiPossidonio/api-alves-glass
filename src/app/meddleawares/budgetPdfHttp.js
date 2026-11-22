import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import auth from './auth.js';
import { requireUser, requireClient } from './authorize.js';
import clientController from '../controllers/ClientBudgetPdfController.js';
import controller from '../controllers/BudgetPdfController.js';
import upload from './budgetPdfUpload.js';
import permissionController from '../controllers/BudgetPermissionController.js';

// Reuse the real session/CSRF middleware, translating only its transport error
// envelope for these routes. Legacy and Features003/004 remain untouched.
export function createBudgetPdfRouter({
  transport = controller,
  multipart = upload,
  client = false,
  permissions = false,
} = {}) {
  const router = Router();
  if (permissions)
    router.use((request, _response, next) =>
      /^\/[0-9a-f-]{36}\/budget-(?:permissions|managers)(?:\/|$)/.test(
        request.path,
      )
        ? next()
        : next('router'),
    );
  router.use((request, response, next) => {
    response.locals.budgetRequestId = randomUUID();
    response.set({
      'Cache-Control': 'private,no-store,max-age=0',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
    });
    const json = response.json.bind(response);
    response.json = (body) => {
      if (response.statusCode >= 400 && typeof body?.error === 'string') {
        const code =
          response.statusCode === 401
            ? 'sessionInvalid'
            : body.error.includes('CSRF')
              ? 'csrfFailed'
              : 'forbidden';
        return json({
          error: {
            code,
            message: code,
            requestId: response.locals.budgetRequestId,
          },
        });
      }
      return json(body);
    };
    next();
  });
  // Shared auth couples session and CSRF. First reuse its read-only path to
  // establish the live session; the actor-type guard runs before handlers.
  // The second invocation below reuses the same CSRF implementation and also
  // rechecks the live session. No token/session verifier is duplicated here.
  router.use(
    (request, response, next) =>
      auth(
        new Proxy(request, {
          get(target, key, receiver) {
            return key === 'method'
              ? 'GET'
              : Reflect.get(target, key, receiver);
          },
        }),
        response,
        next,
      ),
    client ? requireClient : requireUser,
  );
  if (permissions) {
    const origin = (request, response, next) =>
      request.get('origin')
        ? next()
        : response.status(403).json({ error: 'CSRF validation failed' });
    router.get('/:sectorId/budget-permissions', transport.list.bind(transport));
    for (const [method, path] of [
      ['put', '/:sectorId/budget-managers/:userId'],
      ['delete', '/:sectorId/budget-managers/:userId'],
      ['put', '/:sectorId/budget-permissions/:userId/:operation'],
      ['delete', '/:sectorId/budget-permissions/:userId/:operation'],
    ])
      router[method](
        path,
        origin,
        auth,
        requireUser,
        transport.change.bind(transport),
      );
    return router;
  }
  if (client) {
    router.get('/', transport.index.bind(transport));
    router.get('/:id/pdf', transport.pdf.bind(transport));
    router.get('/:id', transport.show.bind(transport));
    return router;
  }
  // Existing auth accepts absent Origin outside production. Mutating budget
  // contract requires an explicit Origin, without changing shared auth policy.
  router.post(
    '/',
    (request, response, next) => {
      if (!request.get('origin'))
        return response.status(403).json({ error: 'CSRF validation failed' });
      next();
    },
    auth,
    requireUser,
    multipart,
    transport.store.bind(transport),
  );
  router.post(
    '/:id/publish',
    (request, response, next) => {
      if (!request.get('origin'))
        return response.status(403).json({ error: 'CSRF validation failed' });
      next();
    },
    auth,
    requireUser,
    transport.publish.bind(transport),
  );
  for (const [method, path, handler] of [
    ['patch', '/:id', 'edit'],
    ['delete', '/:id', 'delete'],
    ['put', '/:id/pending-pdf', 'replace'],
  ]) {
    router[method](
      path,
      (request, response, next) => {
        if (!request.get('origin'))
          return response.status(403).json({ error: 'CSRF validation failed' });
        next();
      },
      auth,
      requireUser,
      ...(method === 'put' ? [multipart] : []),
      (request, response) => transport[handler](request, response),
    );
  }
  router.get('/', transport.index.bind(transport));
  router.get('/:id/pdf', transport.pdf.bind(transport));
  router.get('/:id', transport.show.bind(transport));
  return router;
}
export function createBudgetPermissionRouter({
  transport = permissionController,
} = {}) {
  return createBudgetPdfRouter({ transport, permissions: true });
}
export function createClientBudgetPdfRouter({
  transport = clientController,
} = {}) {
  return createBudgetPdfRouter({ transport, client: true });
}
