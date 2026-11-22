// Authenticated, read-only preflight for the populated T022 database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Sequelize } from 'sequelize';
import { Client } from 'minio';
import { requireBudgetTestEnvironment } from './environment.js';

export async function openBudgetGateEnvironment(
  env = process.env,
  state = 'migrated',
) {
  const target = requireBudgetTestEnvironment(env);
  assert.equal(env.BUDGETS_GATE_EXECUTION_APPROVED, '1');
  assert.match(env.BUDGETS_TEST_IDENTITY_TOKEN ?? '', /^[a-f0-9]{64}$/);
  const db = new Sequelize(target.database, env.DB_USERNAME, env.DB_PASSWORD, {
    dialect: 'postgres',
    host: target.postgres.host,
    port: target.postgres.port,
    logging: false,
    pool: { max: 8, min: 0 },
    dialectOptions: {
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      query_timeout: 15000,
    },
  });
  const rows = async (sql, replacements = {}, transaction) =>
    (await db.query(sql, { replacements, transaction }))[0];
  const client = new Client({
    endPoint: target.minio.host,
    port: target.minio.port,
    useSSL: false,
    region: 'us-east-1',
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
  });
  const transport = client.transport;
  client.transport = {
    request(options, callback) {
      return transport.request(
        { ...options, signal: AbortSignal.timeout(5000) },
        callback,
      );
    },
  };
  try {
    const [identity] =
      await rows(`SELECT current_database() AS database,current_user AS username,
      current_setting('server_version_num')::integer/10000 AS major,pg_get_userbyid(d.datdba) AS owner,
      r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`);
    assert.equal(identity.major, 17);
    assert.equal(identity.database, target.database);
    assert.equal(identity.username, env.DB_USERNAME);
    assert.equal(identity.owner, env.DB_USERNAME);
    for (const field of [
      'rolsuper',
      'rolcreatedb',
      'rolcreaterole',
      'rolreplication',
      'rolbypassrls',
    ])
      assert.equal(identity[field], false);
    const expected = createHash('sha256')
      .update(env.BUDGETS_TEST_IDENTITY_TOKEN)
      .digest('hex');
    assert.deepEqual(
      await rows(
        'SELECT run_id,token_sha256 FROM feature005_test_identity.receipt',
      ),
      [{ run_id: target.runId, token_sha256: expected }],
    );
    const receiptKey = `budgets-pdf/preflight/${target.runId}/identity.json`;
    const stream = await client.getObject(target.bucket, receiptKey);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
      runId: target.runId,
      tokenSha256: expected,
    });
    const anonymous = await fetch(
      `http://${target.minio.host}:${target.minio.port}/${target.bucket}/${receiptKey}`,
      { signal: AbortSignal.timeout(5000) },
    );
    await anonymous.arrayBuffer();
    assert.equal(anonymous.status, 403);
    const listing = await fetch(
      `http://${target.minio.host}:${target.minio.port}/${target.bucket}?list-type=2&prefix=budgets-pdf%2F`,
      { signal: AbortSignal.timeout(5000) },
    );
    await listing.arrayBuffer();
    assert.equal(listing.status, 403);
    // Limited application credentials cannot inspect/change bucket policy.
    await assert.rejects(
      client.getBucketPolicy(target.bucket),
      (error) => error.code === 'AccessDenied',
    );
    const tables = await rows(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    );
    if (state === 'fresh') assert.deepEqual(tables, []);
    else {
      assert.ok(['baseline', 'migrated'].includes(state));
      const applied = await rows(
        'SELECT name FROM public."SequelizeMeta" ORDER BY name',
      );
      const expectedLast =
        state === 'baseline'
          ? '20261126000000-add-service-order-informational-priority.cjs'
          : '20261130000000-enforce-budget-pdf-lifecycle.cjs';
      assert.equal(applied.at(-1)?.name, expectedLast);
      if (state === 'migrated')
        for (const table of [
          'budgets_pdf',
          'budget_pdf_objects',
          'budget_commercial_managers',
          'budget_commercial_permissions',
          'budget_commercial_permission_audit',
        ])
          assert.ok(tables.some((row) => row.tablename === table));
    }
    return { target, db, rows, client };
  } catch (error) {
    await db.close();
    throw error;
  }
}
