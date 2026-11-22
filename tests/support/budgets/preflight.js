// T021 only: no application migrations, Model init, lifecycle suite or worker.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { Client as PgClient } from 'pg';
import { Client as MinioClient } from 'minio';
import { requireBudgetTestEnvironment } from './environment.js';
import { createBudgetPdfRuntimeService } from '../../../src/app/services/BudgetPdfRuntimeService.js';

const env = process.env;
const target = requireBudgetTestEnvironment(env);
assert.equal(
  env.BUDGETS_PREFLIGHT_APPROVED,
  '1',
  'T021_EXPLICIT_APPROVAL_REQUIRED',
);
assert.match(env.BUDGETS_TEST_IDENTITY_TOKEN ?? '', /^[a-f0-9]{64}$/);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const minio = (accessKey, secretKey) =>
  new MinioClient({
    endPoint: target.minio.host,
    port: target.minio.port,
    useSSL: false,
    region: 'us-east-1',
    accessKey,
    secretKey,
  });
const app = minio(env.MINIO_ACCESS_KEY, env.MINIO_SECRET_KEY);
const mode = process.argv[2];
assert.ok(['provision', 'verify', 'policy'].includes(mode));
const base = `http://${target.minio.host}:${target.minio.port}`;
const receiptKey = `budgets-pdf/preflight/${target.runId}/identity.json`;
const identity = {
  runId: target.runId,
  tokenSha256: hash(env.BUDGETS_TEST_IDENTITY_TOKEN),
};
const all = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

async function signedAdmin(root, method, path, body = Buffer.alloc(0)) {
  // Existing SDK signing primitive; schema verified against the pinned MinIO
  // server commit, cmd/admin-handlers-users.go (import-iam raw ZIP).
  const { signV4 } = await import(
    new URL('./signing.mjs', import.meta.resolve('minio'))
  );
  const date = new Date();
  const sha = hash(body);
  const options = {
    method,
    hostname: target.minio.host,
    port: target.minio.port,
    path,
    headers: {
      host: `${target.minio.host}:${target.minio.port}`,
      'x-amz-date': date.toISOString().replace(/[:-]|\.\d{3}/g, ''),
      'x-amz-content-sha256': sha,
      'content-length': String(body.length),
    },
  };
  options.headers.authorization = signV4(
    options,
    root.accessKey,
    root.secretKey,
    'us-east-1',
    date,
    sha,
  );
  return new Promise((resolve, reject) => {
    const request = http.request(
      { ...options, signal: AbortSignal.timeout(10000) },
      async (response) => {
        try {
          const data = await all(response);
          assert.equal(
            response.statusCode,
            200,
            'MINIO_ADMIN_OPERATION_FAILED',
          );
          resolve(data);
        } catch (error) {
          reject(error);
        }
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

async function provisionMinio() {
  assert.equal(env.BUDGETS_NEW_RESOURCES_ONLY, '1');
  const root = minio(env.MINIO_ROOT_USER, env.MINIO_ROOT_PASSWORD);
  assert.notEqual(root.accessKey, env.MINIO_ACCESS_KEY);
  if (await root.bucketExists(target.bucket)) {
    assert.equal(
      env.BUDGETS_RESUME_EMPTY_OWNED_BUCKET,
      '1',
      'REFUSE_EXISTING_BUCKET',
    );
    const contents = [];
    for await (const item of root.listObjectsV2(target.bucket, '', true))
      contents.push(item.name);
    assert.deepEqual(contents, [], 'RESUME_REQUIRES_EMPTY_NEW_BUCKET');
  } else await root.makeBucket(target.bucket, 'us-east-1');
  const archive = await readFile('/run/feature005/iam.zip');
  await signedAdmin(root, 'PUT', '/minio/admin/v3/import-iam', archive);
  const config = await root.getBucketVersioning(target.bucket);
  assert.ok(!config.Status || config.Status === 'Suspended');
  await assert.rejects(root.getObjectLockConfig(target.bucket), (error) =>
    [
      'ObjectLockConfigurationNotFoundError',
      'NoSuchObjectLockConfiguration',
    ].includes(error.code),
  );
  try {
    const policy = await root.getBucketPolicy(target.bucket);
    assert.ok(!policy || !JSON.parse(policy).Statement?.length);
  } catch (error) {
    assert.equal(error.code, 'NoSuchBucketPolicy');
  }
  // Root-owned identity marker is persisted; app can read, but its IAM policy
  // explicitly denies Put/Delete on this marker.
  await root.putObject(
    target.bucket,
    receiptKey,
    Buffer.from(JSON.stringify(identity)),
    undefined,
    { 'Content-Type': 'application/json' },
  );
  console.log(
    JSON.stringify({
      minioProvisioned: true,
      versioning: config.Status ?? 'Disabled',
      retention: false,
      anonymousPolicy: false,
    }),
  );
}

async function verify() {
  assert.notEqual(process.getuid(), 0, 'NON_ROOT_PREFLIGHT_REQUIRED');
  const resources = Object.fromEntries(
    await Promise.all(
      ['memory.max', 'cpu.max', 'pids.max'].map(async (file) => [
        file,
        (await readFile(`/sys/fs/cgroup/${file}`, 'utf8')).trim(),
      ]),
    ),
  );
  assert.equal(resources['memory.max'], '536870912');
  assert.equal(resources['pids.max'], '64');
  const [quota, period] = resources['cpu.max'].split(' ').map(Number);
  assert.equal(quota / period, 1);
  console.log(
    JSON.stringify({ runtimeUid: process.getuid(), cgroup: resources }),
  );
  const db = new PgClient({
    host: target.postgres.host,
    port: target.postgres.port,
    database: target.database,
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  await db.connect();
  try {
    const {
      rows: [actual],
    } =
      await db.query(`SELECT current_database() AS database, current_user AS username,
      current_setting('server_version') AS version, current_setting('server_version_num')::int / 10000 AS major,
      r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
      pg_get_userbyid(d.datdba) AS owner, inet_server_addr()::text AS address,
      has_schema_privilege(current_user,'public','CREATE') AS can_create
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`);
    assert.equal(actual.major, 17);
    assert.equal(actual.database, target.database);
    assert.equal(actual.username, env.DB_USERNAME);
    assert.equal(actual.owner, env.DB_USERNAME);
    assert.equal(actual.can_create, true);
    for (const field of [
      'rolsuper',
      'rolcreatedb',
      'rolcreaterole',
      'rolreplication',
      'rolbypassrls',
    ])
      assert.equal(actual[field], false);
    assert.deepEqual(
      (
        await db.query(
          'SELECT run_id,token_sha256 FROM feature005_test_identity.receipt',
        )
      ).rows,
      [{ run_id: identity.runId, token_sha256: identity.tokenSha256 }],
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public'",
        )
      ).rows,
      [],
      'PUBLIC_SCHEMA_MUST_REMAIN_EMPTY',
    );
    // Prove future DDL rights without persistence or application schema changes.
    await db.query('BEGIN');
    await db.query(
      'CREATE TABLE public.feature005_preflight_ddl_probe(id integer)',
    );
    await db.query('ROLLBACK');
    await assert.rejects(
      db.query('UPDATE feature005_test_identity.receipt SET run_id=run_id'),
      (error) => error.code === '42501',
    );
    const bad = new PgClient({
      host: target.postgres.host,
      port: target.postgres.port,
      database: target.database,
      user: env.DB_USERNAME,
      password: randomUUID(),
      connectionTimeoutMillis: 5000,
    });
    try {
      await assert.rejects(bad.connect(), (error) => error.code === '28P01');
    } finally {
      await bad.end();
    }
    console.log(
      JSON.stringify({
        postgres: actual,
        receiptVerified: true,
        publicEmpty: true,
        ddlProbeRolledBack: true,
        badPasswordDenied: true,
        receiptWriteDenied: true,
      }),
    );
  } finally {
    await db.end();
  }

  assert.deepEqual(
    JSON.parse(
      (await all(await app.getObject(target.bucket, receiptKey))).toString(),
    ),
    identity,
  );
  await assert.rejects(
    app.putObject(target.bucket, receiptKey, Buffer.from('denied')),
    (error) => error.code === 'AccessDenied',
  );
  await assert.rejects(
    app.removeObject(target.bucket, receiptKey),
    (error) => error.code === 'AccessDenied',
  );
  // This MinIO version may return a policy-filtered bucket list rather than
  // reject ListAllMyBuckets. Never accept visibility beyond this run's bucket.
  let bucketVisibility;
  try {
    const visible = await app.listBuckets();
    assert.ok(visible.every((bucket) => bucket.name === target.bucket));
    bucketVisibility = 'filteredToOwnedBucket';
  } catch (error) {
    assert.equal(error.code, 'AccessDenied');
    bucketVisibility = 'denied';
  }
  await assert.rejects(
    app.makeBucket(`${target.bucket}-unauthorized`, 'us-east-1'),
    (error) => error.code === 'AccessDenied',
  );
  await assert.rejects(
    app.putObject(
      target.bucket,
      `outside-prefix-${randomUUID()}`,
      Buffer.from('denied'),
    ),
    (error) => error.code === 'AccessDenied',
  );
  const anonymous = [];
  for (const path of [
    `/${target.bucket}/${receiptKey}`,
    `/${target.bucket}?list-type=2&prefix=budgets-pdf%2F`,
  ]) {
    const response = await fetch(base + path, {
      signal: AbortSignal.timeout(5000),
    });
    anonymous.push(response.status);
    await response.arrayBuffer();
    assert.equal(response.status, 403);
  }
  const key = `budgets-pdf/preflight/${target.runId}/${randomUUID()}.bin`;
  const bytes = Buffer.from(`Feature005 T021 synthetic smoke ${target.runId}`);
  await app.putObject(target.bucket, key, bytes);
  assert.equal((await app.statObject(target.bucket, key)).size, bytes.length);
  assert.deepEqual(await all(await app.getObject(target.bucket, key)), bytes);
  assert.deepEqual(
    await all(await app.getPartialObject(target.bucket, key, 0, 10)),
    bytes.subarray(0, 10),
  );
  const entries = [];
  for await (const item of app.listObjectsV2(
    target.bucket,
    'budgets-pdf/',
    true,
  ))
    entries.push(item.name);
  assert.ok(entries.includes(key));
  const privateResponse = await fetch(`${base}/${target.bucket}/${key}`, {
    signal: AbortSignal.timeout(5000),
  });
  await privateResponse.arrayBuffer();
  assert.equal(privateResponse.status, 403);
  await app.removeObject(target.bucket, key);
  await app.removeObject(target.bucket, key);
  await assert.rejects(app.statObject(target.bucket, key), (error) =>
    ['NotFound', 'NoSuchKey'].includes(error.code),
  );
  const wrong = minio(env.MINIO_ACCESS_KEY, randomUUID());
  await assert.rejects(wrong.getObject(target.bucket, receiptKey), (error) =>
    ['SignatureDoesNotMatch', 'AccessDenied'].includes(error.code),
  );
  console.log(
    JSON.stringify({
      minioIdentityVerified: true,
      anonymousDenied: anonymous,
      markerWriteDenied: true,
      bucketVisibility,
      bucketCreationDenied: true,
      outsidePrefixDenied: true,
      putStatGetRangeListRemove: true,
      repeatedRemove: true,
      badSecretDenied: true,
    }),
  );
  console.log(
    JSON.stringify({
      qpdf: await createBudgetPdfRuntimeService().ensureUploadsReady(),
    }),
  );
  console.log(
    'FEATURE005_T021_PREFLIGHT_PASSED_NO_MIGRATIONS_NO_WORKER_NO_T022',
  );
}

try {
  if (mode === 'provision') await provisionMinio();
  else if (mode === 'policy') {
    assert.equal(env.BUDGETS_NEW_RESOURCES_ONLY, '1');
    const root = minio(env.MINIO_ROOT_USER, env.MINIO_ROOT_PASSWORD);
    assert.deepEqual(
      JSON.parse(
        (await all(await root.getObject(target.bucket, receiptKey))).toString(),
      ),
      identity,
    );
    await signedAdmin(
      root,
      'PUT',
      '/minio/admin/v3/import-iam',
      await readFile('/run/feature005/iam.zip'),
    );
    console.log('FEATURE005_OWNED_POLICY_UPDATED');
  } else await verify();
} catch (error) {
  // Never print SDK inputs, credentials, raw response or a stack.
  console.error(
    JSON.stringify({
      preflightFailed: true,
      code: /^[A-Za-z0-9_]+$/.test(error.code ?? '')
        ? error.code
        : 'ASSERTION_OR_RUNTIME_FAILURE',
      check: error.operator ?? null,
      actual:
        typeof error.actual === 'number' || typeof error.actual === 'boolean'
          ? error.actual
          : null,
      expected:
        typeof error.expected === 'number' ||
        typeof error.expected === 'boolean'
          ? error.expected
          : null,
      location:
        error.stack
          ?.split('\n')
          .find((line) => line.includes('preflight.js:'))
          ?.replace(/.*preflight.js:/, '') ?? null,
    }),
  );
  process.exitCode = 1;
}
