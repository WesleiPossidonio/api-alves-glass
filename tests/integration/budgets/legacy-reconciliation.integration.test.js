import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { matrixFixture } from '../../support/budgets/matrix-fixture.js';

const digest = (rows) =>
  createHash('sha256').update(JSON.stringify(rows)).digest('hex');

test('T030 read-only legacy inventory; isolated anonymous fixtures do not become new budgets', async () => {
  const f = await matrixFixture();
  const snapshot = async () =>
    f.rows('SELECT to_jsonb(b) AS value FROM public.budget b ORDER BY id');
  try {
    const before = digest(await snapshot());
    const columns = await f.rows(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='budget'",
    );
    for (const column of [
      'id',
      'client_id',
      'name_budget',
      'description_budget',
      'expiration_date',
      'total_value',
      'pdf_object_name',
      'created_at',
      'updated_at',
    ])
      assert.ok(columns.some((row) => row.column_name === column));
    for (const column of [
      'sector_id',
      'created_by',
      'commercial_number',
      'published_object_id',
    ])
      assert.ok(!columns.some((row) => row.column_name === column));
    // TEMP lives only in this transaction/connection; never INSERT into budget.
    await f.tx(async (transaction) => {
      const query = (sql, replacements = {}) =>
        f.db.query(sql, { transaction, replacements });
      await query(
        'CREATE TEMP TABLE legacy_inventory_fixture (LIKE public.budget INCLUDING DEFAULTS) ON COMMIT DROP',
      );
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      for (let i = 0; i < ids.length; i++)
        await query(
          `INSERT INTO legacy_inventory_fixture(id,client_id,name_budget,description_budget,expiration_date,total_value,pdf_object_name,created_at,updated_at)
          VALUES (:id,:client,'synthetic','synthetic','2027-01-01T03:00:00Z',0,:key,now(),now())`,
          {
            id: ids[i],
            client: i === 2 ? null : f.clientId,
            key: i === 2 ? null : 'synthetic/shared.pdf',
          },
        );
      const [rows] = await query(
        'SELECT to_jsonb(b) AS value FROM legacy_inventory_fixture b ORDER BY id',
      );
      assert.equal(rows.length, 3);
      assert.equal(new Set(rows.map((r) => r.value.id)).size, 3);
      const checksum = digest(rows);
      const [[counts]] =
        await query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE client_id IS NULL)::int AS missing_client,
        count(*) FILTER (WHERE pdf_object_name IS NULL)::int AS missing_document FROM legacy_inventory_fixture`);
      assert.deepEqual(counts, {
        total: 3,
        missing_client: 1,
        missing_document: 1,
      });
      const [duplicates] = await query(
        'SELECT count(*)::int AS n FROM legacy_inventory_fixture WHERE pdf_object_name IS NOT NULL GROUP BY pdf_object_name HAVING count(*)>1',
      );
      assert.deepEqual(duplicates, [{ n: 2 }]);
      // Historical authorship/sector/number/ACL/hash are absent, not inferred
      // from operator, name, UUID, timestamps or filename. Every row is blocked.
      for (const { value } of rows) {
        assert.equal(value.created_by, undefined);
        assert.equal(value.sector_id, undefined);
        assert.equal(value.commercial_number, undefined);
        assert.match(value.id, /^[a-f0-9-]{36}$/);
        const [[count]] = await query(
          'SELECT count(*)::int AS n FROM public.budgets_pdf WHERE id=:id',
          { id: value.id },
        );
        assert.equal(count.n, 0);
      }
      const [after] = await query(
        'SELECT to_jsonb(b) AS value FROM legacy_inventory_fixture b ORDER BY id',
      );
      assert.equal(digest(after), checksum);
    });
    assert.equal(digest(await snapshot()), before);
    const routes = await readFile(
      new URL('../../../src/routes.js', import.meta.url),
      'utf8',
    );
    assert.match(
      routes,
      /routes\.post\(\s*'\/budged',\s*requireAdmin,\s*upload\.single\('file'\),\s*BudgetController\.store,?\s*\)/,
    );
    const repository = await readFile(
      new URL(
        '../../../src/app/repositories/BudgetPdfRepository.js',
        import.meta.url,
      ),
      'utf8',
    );
    assert.doesNotMatch(repository, /public\.budget\b|UNION/i);
  } finally {
    await f.db.close();
  }
});

test('T064 synthetic backup is recoverable without importing or mutating legacy budget', async () => {
  const f = await matrixFixture();
  const root = await mkdtemp(join(tmpdir(), 'budget-legacy-rollback-'));
  try {
    const before = await f.rows(
      'SELECT to_jsonb(b) AS value FROM public.budget b ORDER BY id',
    );
    const checksum = digest(before);
    const backup = join(root, 'synthetic-backup.json');
    const sample = [
      {
        id: randomUUID(),
        client_id: f.clientId,
        sector_id: null,
        author: null,
      },
      { id: randomUUID(), client_id: null, sector_id: null, author: null },
    ];
    await writeFile(
      backup,
      JSON.stringify({
        count: sample.length,
        checksum: digest(sample),
        rows: sample,
      }),
      { mode: 0o600 },
    );
    const recovered = JSON.parse(await readFile(backup, 'utf8'));
    assert.equal(recovered.count, 2);
    assert.equal(digest(recovered.rows), recovered.checksum);
    assert.deepEqual(recovered.rows, sample);
    assert.equal(recovered.rows[1].client_id, null); // RESTRICT: cannot fabricate a client.
    for (const row of recovered.rows) {
      assert.equal(row.sector_id, null);
      assert.equal(row.author, null);
      assert.equal(
        (
          await f.rows('SELECT id FROM public.budgets_pdf WHERE id=:id', {
            id: row.id,
          })
        ).length,
        0,
      );
    }
    assert.equal(
      digest(
        await f.rows(
          'SELECT to_jsonb(b) AS value FROM public.budget b ORDER BY id',
        ),
      ),
      checksum,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await f.db.close();
  }
});
