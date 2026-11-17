import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const routesUrl = new URL('../../../src/routes.js', import.meta.url);

test('quality commands and permission administration have authenticated routes', async () => {
  const routes = await readFile(routesUrl, 'utf8');
  const productMutations = [
    ...routes.matchAll(
      /routes\.(post|put|patch|delete)\(\s*'(\/service-orders[^']*products[^']*)'/g,
    ),
  ];
  assert.deepEqual(
    productMutations.map((match) => [match[1], match[2]]),
    [['patch', '/service-orders/:id/products/:productId']],
  );
  assert.match(
    routes,
    /routes\.get\(\s*'\/service-orders\/client\/me'\s*,\s*requireClient\s*,\s*ServiceOrderController\.clientOrders\.bind/s,
  );
  assert.match(
    routes,
    /routes\.get\(\s*'\/service-orders\/:id'\s*,\s*requireUser\s*,\s*ServiceOrderController\.show\.bind/s,
  );

  for (const [path, handler] of [
    ["'/service-orders/:id/quality'", 'reportQuality'],
    ["'/service-order-quality/:qualityId/decision'", 'decideQuality'],
    ["'/service-order-quality/:qualityId/inspections'", 'inspectQuality'],
    ["'/service-orders/assume'", 'assume'],
    ["'/service-orders/:id/responsibility/release'", 'releaseResponsibility'],
    ["'/service-orders/:id/cancel'", 'cancel'],
    ["'/service-orders/:id/priority'", 'setPriority'],
    ["'/service-orders/:id/production/confirm-closure'", 'closeProduction'],
    ["'/service-orders/:id/confirm-completion'", 'complete'],
    ["'/service-orders/:id/status'", 'transitionStatus'],
  ]) {
    const route = new RegExp(
      `routes\\.post\\(\\s*${path}\\s*,\\s*requireUser\\s*,\\s*ServiceOrderController\\.${handler}\\.bind`,
    );
    assert.match(routes, route);
  }

  assert.match(
    routes,
    /routes\.put\(\s*'\/service-order-permissions'\s*,\s*requireUser\s*,\s*ServiceOrderController\.configurePermission\.bind/s,
  );
  assert.match(
    routes,
    /routes\.delete\(\s*'\/service-order-permissions\/:grantId'\s*,\s*requireAdmin\s*,\s*ServiceOrderController\.revokePermission\.bind/s,
  );
  assert.ok(
    routes.indexOf('routes.use(authMiddlewares)') <
      routes.indexOf("'/service-orders/:id/quality'"),
    'feature routes must remain behind session, Origin and CSRF middleware',
  );
  assert.match(
    routes,
    /routes\.patch\(\s*'\/service-orders\/:id\/products\/:productId'\s*,\s*requireUser\s*,\s*ServiceOrderController\.correctProduct\.bind/s,
  );
});
