import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('T060 legacy POST composition remains authenticated, admin-only and multipart; no 410 or replacement', async () => {
  const routes = await readFile(
    new URL('../../../src/routes.js', import.meta.url),
    'utf8',
  );
  const legacy = await readFile(
    new URL(
      '../../../src/app/controllers/BudgetController.js',
      import.meta.url,
    ),
    'utf8',
  );
  const historical = await readFile(
    new URL(
      '../../../src/database/migrations/20261110000200-create-orders-and-budgets.cjs',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(routes, /routes\.use\(authMiddlewares\);/);
  assert.match(
    routes,
    /routes\.post\('\/budged', requireAdmin, upload\.single\('file'\), BudgetController\.store\)/,
  );
  assert.equal((routes.match(/routes\.post\('\/budged'/g) ?? []).length, 1);
  assert.ok(
    routes.indexOf('routes.use(authMiddlewares)') <
      routes.indexOf("routes.post('/budged'"),
  );
  assert.doesNotMatch(
    routes,
    /legacyBudgetEndpointRetired|successorPath|\.put\('\/budged'/,
  );
  assert.match(legacy, /store\s*\(/);
  assert.match(historical, /budget/);
  for (const migration of [
    '20261127000000-create-budget-commercial-authorization.cjs',
    '20261128000000-create-budget-pdf-objects.cjs',
    '20261129000000-create-budgets-pdf.cjs',
    '20261130000000-enforce-budget-pdf-lifecycle.cjs',
  ]) {
    const sql = await readFile(
      new URL(`../../../src/database/migrations/${migration}`, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(
      sql,
      /(?:DROP|ALTER|TRUNCATE)\s+TABLE\s+(?:public\.)?budget\b/i,
    );
  }
});
