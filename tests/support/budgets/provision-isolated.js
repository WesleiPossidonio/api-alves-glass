import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  API_IMAGE,
  PG_IMAGE,
  MINIO_IMAGE,
  ROOT,
  execute,
  docker,
  save,
  envText,
  privatePath,
  containerBase,
  isMain,
  resourceProvenAbsent,
} from './operational-common.js';
import { iamZip } from './iam-zip.js';
import { verify } from './verify-resources.js';

export async function provision(argv = process.argv.slice(2)) {
  assert.equal(process.env.FEATURE005_T021_APPROVED, '1');
  const { values } = parseArgs({
    args: argv,
    options: {
      'state-root': {
        type: 'string',
        default: join(
          homedir(),
          '.local/state/alves-glass/integration/feature005',
        ),
      },
    },
  });
  const branch = await execute('git', ['-C', ROOT, 'branch', '--show-current']);
  assert.equal(branch.code, 0);
  assert.equal(branch.output.trim(), 'feature/005-budgets-pdf');
  process.umask(0o077);
  const state = resolve(values['state-root']);
  assert.ok(state !== ROOT && !state.startsWith(ROOT + '/'));
  await mkdir(state, { recursive: true, mode: 0o700 });
  await privatePath(state, true);
  assert.equal(await realpath(state), state);
  const run = randomBytes(6).toString('hex'),
    directory = join(state, run);
  await mkdir(directory, { mode: 0o700 });
  const prefix = `feature005-test-${run}`,
    network = `${prefix}-network`;
  const pg = `${prefix}-postgres`,
    minio = `${prefix}-minio`,
    volumes = [`${pg}-data`, `${minio}-data`];
  const label = `io.alvesglass.feature005.run=${run}`,
    database = `feature005_test_${run}`;
  const secret = () => randomBytes(32).toString('hex');
  const password = secret(),
    adminPassword = secret(),
    minioPassword = secret(),
    token = secret(),
    rootPassword = secret(),
    rootUser = `f005root${run}`;
  const env = {
    NODE_ENV: 'test',
    RUN_BUDGETS_INTEGRATION: '1',
    BUDGETS_PREFLIGHT_APPROVED: '1',
    BUDGETS_TEST_RUN_ID: run,
    BUDGETS_TEST_POSTGRES_MAJOR: '17',
    BUDGETS_TEST_NETWORK: network,
    BUDGETS_TEST_POSTGRES_VOLUME: volumes[0],
    BUDGETS_TEST_MINIO_VOLUME: volumes[1],
    DB_HOST: 'feature005-test-postgres',
    DB_PORT: '5432',
    DB_DATABASE: database,
    DB_USERNAME: database,
    DB_PASSWORD: password,
    MINIO_ENDPOINT: 'feature005-test-minio',
    MINIO_PORT: '9000',
    MINIO_USE_SSL: 'false',
    MINIO_BUCKET_PRIVATE: prefix,
    MINIO_ACCESS_KEY: prefix,
    MINIO_SECRET_KEY: minioPassword,
    BUDGETS_TEST_IDENTITY_TOKEN: token,
  };
  const envFile = async (name, data) => {
    const path = join(directory, name);
    await save(path, envText(data), true);
    return path;
  };
  const appEnv = await envFile('app.env', env);
  const provisionEnv = await envFile('provision.env', {
    ...env,
    BUDGETS_NEW_RESOURCES_ONLY: '1',
    MINIO_ROOT_USER: rootUser,
    MINIO_ROOT_PASSWORD: rootPassword,
  });
  const pgEnv = await envFile('postgres.env', {
    POSTGRES_USER: 'postgres',
    POSTGRES_PASSWORD: adminPassword,
    POSTGRES_DB: 'postgres',
    POSTGRES_INITDB_ARGS: '--auth-host=scram-sha-256',
  });
  const minioEnv = await envFile('minio.env', {
    MINIO_ROOT_USER: rootUser,
    MINIO_ROOT_PASSWORD: rootPassword,
    MINIO_SITE_REGION: 'us-east-1',
    MINIO_BROWSER: 'off',
  });
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Deny',
        Action: ['s3:ListAllMyBuckets'],
        Resource: ['arn:aws:s3:::*'],
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetBucketLocation'],
        Resource: [`arn:aws:s3:::${prefix}`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:ListBucket'],
        Resource: [`arn:aws:s3:::${prefix}`],
        Condition: { StringLike: { 's3:prefix': ['budgets-pdf/*'] } },
      },
      {
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:AbortMultipartUpload',
          's3:ListMultipartUploadParts',
        ],
        Resource: [`arn:aws:s3:::${prefix}/budgets-pdf/*`],
      },
      {
        Effect: 'Deny',
        Action: ['s3:PutObject', 's3:DeleteObject'],
        Resource: [
          `arn:aws:s3:::${prefix}/budgets-pdf/preflight/${run}/identity.json`,
        ],
      },
    ],
  };
  const policyName = `${prefix}-pdf-only`;
  await save(join(directory, 'policy.json'), policy, true);
  await save(
    join(directory, 'iam.zip'),
    iamZip({
      'policies.json': { [policyName]: policy },
      'users.json': {
        [prefix]: { secretKey: minioPassword, status: 'enabled' },
      },
      'user_mappings.json': { [prefix]: { version: 1, policy: policyName } },
    }),
    true,
  );
  const receipt = {
    runId: run,
    network,
    postgresContainer: pg,
    minioContainer: minio,
    postgresVolume: volumes[0],
    minioVolume: volumes[1],
    database,
    bucket: prefix,
    postgresImage: PG_IMAGE,
    minioImage: MINIO_IMAGE,
    apiImage: API_IMAGE,
    credentialsDirectory: directory,
    schemaMigrationsApplied: false,
  };
  const manifest = join(directory, 'resources.json');
  await save(manifest, receipt, true);
  console.log(`FEATURE005_PRIVATE_STATE=${directory}`);
  // Check daemon and exact local images before collision checks or creation.
  await docker(['info', '--format', '{{.ServerVersion}}']);
  for (const image of [PG_IMAGE, MINIO_IMAGE, API_IMAGE])
    await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  for (const [kind, names] of [
    ['network', [network]],
    ['volume', volumes],
    ['container', [pg, minio]],
  ]) {
    for (const name of names) {
      const result = await execute('docker', [kind, 'inspect', name]);
      assert.ok(
        resourceProvenAbsent(result, kind, name),
        'RESOURCE_NOT_PROVEN_ABSENT',
      );
    }
  }
  await docker(['network', 'create', '--internal', '--label', label, network]);
  for (const volume of volumes)
    await docker(['volume', 'create', '--label', label, volume]);
  const common = [
    '--network',
    network,
    '--label',
    label,
    '--memory',
    '512m',
    '--memory-swap',
    '512m',
    '--cpus',
    '1',
    '--pids-limit',
    '64',
    '--security-opt',
    'no-new-privileges',
    '--restart',
    'no',
  ];
  receipt.postgresId = await docker([
    'run',
    '-d',
    '--name',
    pg,
    ...common,
    '--network-alias',
    'feature005-test-postgres',
    '--env-file',
    pgEnv,
    '--mount',
    `type=volume,src=${volumes[0]},dst=/var/lib/postgresql/data`,
    PG_IMAGE,
  ]);
  await save(manifest, receipt);
  receipt.minioId = await docker([
    'run',
    '-d',
    '--name',
    minio,
    ...common,
    '--network-alias',
    'feature005-test-minio',
    '--env-file',
    minioEnv,
    '--mount',
    `type=volume,src=${volumes[1]},dst=/data`,
    MINIO_IMAGE,
    'server',
    '/data',
    '--address',
    ':9000',
  ]);
  await save(manifest, receipt);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (
      (await execute('docker', ['exec', pg, 'pg_isready', '-U', 'postgres']))
        .code === 0
    ) {
      ready = true;
      break;
    }
    await delay(1000);
  }
  assert.ok(ready);
  await docker(
    [
      'exec',
      '-i',
      pg,
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-d',
      'postgres',
    ],
    {
      input: `CREATE ROLE ${database} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE ${database} OWNER ${database};
REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
GRANT CONNECT,TEMPORARY ON DATABASE ${database} TO ${database};
\\connect ${database}
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE,CREATE ON SCHEMA public TO ${database};
CREATE SCHEMA feature005_test_identity AUTHORIZATION postgres;
CREATE TABLE feature005_test_identity.receipt(run_id text PRIMARY KEY,token_sha256 text NOT NULL);
INSERT INTO feature005_test_identity.receipt VALUES ('${run}','${createHash('sha256').update(token).digest('hex')}');
REVOKE ALL ON SCHEMA feature005_test_identity FROM PUBLIC;
GRANT USAGE ON SCHEMA feature005_test_identity TO ${database};
GRANT SELECT ON feature005_test_identity.receipt TO ${database};`,
    },
  );
  await delay(3000);
  for (const mode of ['provision', 'verify']) {
    const result = await docker([
      ...containerBase(network),
      '--label',
      label,
      '--env-file',
      mode === 'provision' ? provisionEnv : appEnv,
      ...(mode === 'provision'
        ? ['--mount', `type=bind,src=${directory},dst=/run/feature005,readonly`]
        : []),
      '--entrypoint',
      'node',
      API_IMAGE,
      'tests/support/budgets/preflight.js',
      mode,
    ]);
    await save(join(directory, `${mode}.log`), result + '\n');
    console.log(result);
  }
  await verify(manifest);
  receipt.preflightPassed = true;
  await save(manifest, receipt);
  console.log(`FEATURE005_T021_RESOURCES_VERIFIED=${manifest}`);
  return manifest;
}
if (isMain(import.meta.url)) {
  try {
    await provision();
  } catch {
    console.error('FEATURE005_T021_STOPPED_RESOURCES_PRESERVED');
    process.exitCode = 1;
  }
}
