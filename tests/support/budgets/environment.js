// Inert declaration guard: no dotenv, application imports, DNS, sockets or cleanup.
// This validates declared isolation, not remote ownership or a disposable server.
export class BudgetTestEnvironmentError extends Error {
  constructor(code) {
    super(`Budget integration environment blocked: ${code}`);
    this.name = 'BudgetTestEnvironmentError';
    this.code = code;
  }
}

function requireCondition(condition, code) {
  if (!condition) throw new BudgetTestEnvironmentError(code);
}

function endpoint(host, port, service, localPort, containerPort) {
  return (
    (['127.0.0.1', 'localhost', '::1'].includes(host) && port === localPort) ||
    (host === `feature005-test-${service}` && port === containerPort)
  );
}

export function requireBudgetTestEnvironment(env = {}) {
  requireCondition(env.NODE_ENV === 'test', 'NODE_ENV_TEST_REQUIRED');
  requireCondition(
    env.RUN_BUDGETS_INTEGRATION === '1',
    'EXPLICIT_OPT_IN_REQUIRED',
  );
  requireCondition(
    env.BUDGETS_TEST_POSTGRES_MAJOR === '17',
    'POSTGRES_17_REQUIRED',
  );
  const runId = env.BUDGETS_TEST_RUN_ID;
  requireCondition(
    typeof runId === 'string' && /^[a-f0-9]{8,32}$/.test(runId),
    'INVALID_RUN_ID',
  );
  const names = {
    database: `feature005_test_${runId}`,
    bucket: `feature005-test-${runId}`,
    network: `feature005-test-${runId}-network`,
    postgresVolume: `feature005-test-${runId}-postgres-data`,
    minioVolume: `feature005-test-${runId}-minio-data`,
  };
  if (env.BUDGETS_TEST_FIXTURE_ID !== undefined) {
    requireCondition(
      /^[a-f0-9]{12}$/.test(env.BUDGETS_TEST_FIXTURE_ID),
      'INVALID_FIXTURE_ID',
    );
    requireCondition(
      env.BUDGETS_EMPTY_ROLLBACK_FIXTURE_APPROVED === '1',
      'EXPLICIT_FIXTURE_APPROVAL_REQUIRED',
    );
    names.database += `_fixture_${env.BUDGETS_TEST_FIXTURE_ID}`;
  }
  for (const [field, variable] of Object.entries({
    database: 'DB_DATABASE',
    bucket: 'MINIO_BUCKET_PRIVATE',
    network: 'BUDGETS_TEST_NETWORK',
    postgresVolume: 'BUDGETS_TEST_POSTGRES_VOLUME',
    minioVolume: 'BUDGETS_TEST_MINIO_VOLUME',
  }))
    requireCondition(
      env[variable] === names[field],
      `ISOLATED_${field.toUpperCase()}_REQUIRED`,
    );

  requireCondition(
    endpoint(env.DB_HOST, env.DB_PORT, 'postgres', '55435', '5432'),
    'POSTGRES_ENDPOINT_NOT_ALLOWLISTED',
  );
  requireCondition(
    endpoint(env.MINIO_ENDPOINT, env.MINIO_PORT, 'minio', '59005', '9000'),
    'MINIO_ENDPOINT_NOT_ALLOWLISTED',
  );
  requireCondition(
    env.MINIO_USE_SSL === 'false',
    'ISOLATED_MINIO_TRANSPORT_REQUIRED',
  );
  requireCondition(
    env.DB_USERNAME === `feature005_test_${runId}`,
    'ISOLATED_DB_USER_REQUIRED',
  );
  requireCondition(
    env.MINIO_ACCESS_KEY === `feature005-test-${runId}`,
    'ISOLATED_MINIO_USER_REQUIRED',
  );
  for (const key of ['DB_PASSWORD', 'MINIO_SECRET_KEY']) {
    requireCondition(
      typeof env[key] === 'string' && env[key].trim().length >= 16,
      'EXTERNAL_TEST_CREDENTIALS_REQUIRED',
    );
  }
  // Fail closed on alternative connection settings: never silently fall back to .env.
  for (const key of [
    'DATABASE_URL',
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'MINIO_BUCKET',
    'MINIO_BUCKET_PUBLIC',
    'MINIO_PRIVATE_BUCKET',
    'MINIO_PUBLIC_BUCKET',
    'MINIO_URL',
    'MINIO_CA_CERT_PATH',
    'BASELINE_DB_HOST',
    'BASELINE_DB_DATABASE',
    'MONGODB_URI',
    'RABBITMQ_URL',
  ]) {
    requireCondition(
      env[key] === undefined || env[key] === '',
      'CONFLICTING_CONNECTION_CONFIGURATION',
    );
  }
  requireCondition(
    env.DOTENV_CONFIG_PATH === undefined && env.NODE_OPTIONS === undefined,
    'IMPLICIT_CONFIGURATION_NOT_ALLOWED',
  );

  return Object.freeze({
    runId,
    ...names,
    postgres: Object.freeze({
      host: env.DB_HOST,
      port: Number(env.DB_PORT),
      database: names.database,
    }),
    minio: Object.freeze({
      host: env.MINIO_ENDPOINT,
      port: Number(env.MINIO_PORT),
      bucket: names.bucket,
    }),
    // No credentials, raw input, URLs, clients, cleanup permissions or ownership tokens returned.
  });
}
