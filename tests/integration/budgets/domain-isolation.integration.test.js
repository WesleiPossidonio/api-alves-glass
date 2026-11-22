import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matrixFixture } from '../../support/budgets/matrix-fixture.js';

test('T062 budget lifecycle does not mutate OS, inventory or legacy budget', async () => {
  const f = await matrixFixture();
  const tables = [
    'service_orders',
    'service_order_events',
    'service_order_outbox',
    'materials',
    'material_balances',
    'inventory_events',
    'stock_movements',
    'budget',
  ];
  const snapshot = async () =>
    Promise.all(
      tables.map(async (name) => {
        const [row] = await f.rows(
          `SELECT count(*)::integer AS count FROM public."${name}"`,
        );
        return [name, row.count];
      }),
    );
  try {
    const before = await snapshot();
    const item = await f.attached();
    assert.ok(await f.Budget.findByPk(item.proof.owner_budget_id));
    assert.deepEqual(await snapshot(), before);
    await f.tx((transaction) => f.detach(item, transaction));
    await f.worker.processClaim(await f.claim(item));
    assert.equal(await f.storage.stat(item.proof), null);
    assert.deepEqual(await snapshot(), before);
    for (const file of [
      'BudgetPdfCreateService.js',
      'BudgetPdfDeleteService.js',
      'BudgetPdfCleanupWorker.js',
    ]) {
      const source = await readFile(
        new URL(`../../../src/app/services/${file}`, import.meta.url),
        'utf8',
      );
      assert.doesNotMatch(
        source,
        /from ['"][^'"]*(?:amqplib|mongodb|Rabbit|Outbox|Inventory|ServiceOrder)/i,
      );
    }
  } finally {
    await f.db.close();
  }
});
