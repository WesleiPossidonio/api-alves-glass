import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { requireBudgetTestEnvironment } from '../../support/budgets/environment.js';
import { runBudgetSuite } from '../../support/budgets/run.js';

function syntheticEnv() {
  return {
    NODE_ENV: 'test',
    RUN_BUDGETS_INTEGRATION: '1',
    BUDGETS_TEST_POSTGRES_MAJOR: '17',
    BUDGETS_TEST_RUN_ID: 'abcdef01',
    DB_HOST: '127.0.0.1',
    DB_PORT: '55435',
    DB_DATABASE: 'feature005_test_abcdef01',
    DB_USERNAME: 'feature005_test_abcdef01',
    DB_PASSWORD: 'synthetic-only-password',
    MINIO_ENDPOINT: '127.0.0.1',
    MINIO_PORT: '59005',
    MINIO_USE_SSL: 'false',
    MINIO_BUCKET_PRIVATE: 'feature005-test-abcdef01',
    MINIO_ACCESS_KEY: 'feature005-test-abcdef01',
    MINIO_SECRET_KEY: 'synthetic-only-secret',
    BUDGETS_TEST_NETWORK: 'feature005-test-abcdef01-network',
    BUDGETS_TEST_POSTGRES_VOLUME: 'feature005-test-abcdef01-postgres-data',
    BUDGETS_TEST_MINIO_VOLUME: 'feature005-test-abcdef01-minio-data',
  };
}

test('T002 validates inert isolated declarations without returning secrets or cleanup authority', () => {
  const result = requireBudgetTestEnvironment(syntheticEnv());
  assert.equal(result.database, 'feature005_test_abcdef01');
  assert.equal(result.postgres.port, 55435);
  assert.equal(Object.isFrozen(result.minio), true);
  assert.equal(JSON.stringify(result).includes('synthetic-only'), false);
  assert.equal(result.cleanup, undefined);
  assert.throws(() => requireBudgetTestEnvironment(), /NODE_ENV_TEST_REQUIRED/);
});

test('T021 accepts PostgreSQL 17 only; missing or alternative versions fail before I/O', () => {
  for (const major of [undefined, '16', '18', '17.11', '']) {
    assert.throws(
      () =>
        requireBudgetTestEnvironment({
          ...syntheticEnv(),
          BUDGETS_TEST_POSTGRES_MAJOR: major,
        }),
      /POSTGRES_17_REQUIRED/,
    );
  }
});

test('T022 disposable rollback fixture requires exact suffix and independent opt-in', () => {
  const env = {
    ...syntheticEnv(),
    BUDGETS_TEST_FIXTURE_ID: 'abcdef012345',
    DB_DATABASE: 'feature005_test_abcdef01_fixture_abcdef012345',
  };
  assert.throws(
    () => requireBudgetTestEnvironment(env),
    /EXPLICIT_FIXTURE_APPROVAL_REQUIRED/,
  );
  assert.equal(
    requireBudgetTestEnvironment({
      ...env,
      BUDGETS_EMPTY_ROLLBACK_FIXTURE_APPROVED: '1',
    }).database,
    env.DB_DATABASE,
  );
  for (const patch of [
    { BUDGETS_TEST_FIXTURE_ID: '../shared' },
    { DB_DATABASE: 'shared' },
    { DB_DATABASE: syntheticEnv().DB_DATABASE },
  ])
    assert.throws(() =>
      requireBudgetTestEnvironment({
        ...env,
        BUDGETS_EMPTY_ROLLBACK_FIXTURE_APPROVED: '1',
        ...patch,
      }),
    );
});

test('T002 permits only the dedicated container endpoint pairs or dedicated loopback ports', () => {
  assert.doesNotThrow(() =>
    requireBudgetTestEnvironment({
      ...syntheticEnv(),
      DB_HOST: 'feature005-test-postgres',
      DB_PORT: '5432',
      MINIO_ENDPOINT: 'feature005-test-minio',
      MINIO_PORT: '9000',
    }),
  );
  for (const patch of [
    { NODE_ENV: 'production' },
    { RUN_BUDGETS_INTEGRATION: 'true' },
    { RUN_BUDGETS_INTEGRATION: '' },
    { BUDGETS_TEST_RUN_ID: '../prod' },
    { DB_HOST: 'production.example' },
    { DB_PORT: '5432' },
    { DB_DATABASE: 'alvesglass_test' },
    { DB_USERNAME: 'postgres' },
    { MINIO_PORT: '9000' },
    { MINIO_ENDPOINT: 'feature004-recovery-minio' },
    { MINIO_BUCKET_PRIVATE: 'private' },
    { MINIO_USE_SSL: 'true' },
    { BUDGETS_TEST_NETWORK: 'shared' },
    { BUDGETS_TEST_POSTGRES_VOLUME: 'postgres_data' },
    { BUDGETS_TEST_MINIO_VOLUME: '' },
    { DB_PASSWORD: '' },
    { MINIO_SECRET_KEY: 'short' },
    { DATABASE_URL: 'postgres://secret@prod' },
    { PGHOST: 'prod' },
    { MINIO_BUCKET: 'legacy' },
    { MINIO_PRIVATE_BUCKET: 'shared-private' },
    { MINIO_PUBLIC_BUCKET: 'shared-public' },
    { MONGODB_URI: 'mongodb://shared' },
    { NODE_OPTIONS: '--import=/tmp/unsafe.js' },
    { DOTENV_CONFIG_PATH: '.env' },
  ]) {
    let calls = 0;
    assert.throws(() =>
      runBudgetSuite('integration', { ...syntheticEnv(), ...patch }, () => {
        calls++;
      }),
    );
    assert.equal(calls, 0, JSON.stringify(Object.keys(patch)));
  }
});

test('T004 unit runner strips inherited connection configuration and uses only local setup tests', () => {
  let call;
  assert.equal(
    runBudgetSuite(
      'unit',
      { DB_PASSWORD: 'must-not-leak', DATABASE_URL: 'must-not-leak' },
      (...args) => {
        call = args;
        return { status: 0 };
      },
    ),
    0,
  );
  assert.equal(call[0], process.execPath);
  assert.equal(call[2].shell, false);
  assert.equal(call[2].env.DB_PASSWORD, undefined);
  assert.equal(call[2].env.DATABASE_URL, undefined);
  assert.equal(
    call[1]
      .filter((arg) => arg.endsWith('.test.js'))
      .every((arg) => arg.includes('/tests/unit/budgets/')),
    true,
  );
});

test('T022 operational runner requires approval and explicit scenario; contracts propagate failures', () => {
  assert.throws(
    () => runBudgetSuite('worker', syntheticEnv(), () => {}),
    /BUDGET_WORKER_EXECUTION_APPROVAL_REQUIRED/,
  );
  assert.throws(
    () => runBudgetSuite('integration', syntheticEnv(), () => {}),
    /BUDGET_INTEGRATION_SCENARIO_REQUIRED/,
  );
  const env = {
    ...syntheticEnv(),
    BUDGETS_GATE_EXECUTION_APPROVED: '1',
    BUDGETS_INTEGRATION_SCENARIO: 'migrated',
  };
  for (const status of [0, 20, 21, 22])
    assert.equal(
      runBudgetSuite('integration', env, (_binary, args, options) => {
        assert.ok(args[0].endsWith('/integration-cli.js'));
        assert.equal(options.env.BUDGETS_GATE_EXECUTION_APPROVED, '1');
        return { status };
      }),
      status,
    );
  assert.equal(
    runBudgetSuite('contract', {}, () => ({ status: 1 })),
    22,
  );
  assert.equal(
    runBudgetSuite('contract', {}, () => ({
      error: new Error('failed spawn'),
    })),
    21,
  );
});

test('T002 guard errors never echo rejected credentials or connection strings', () => {
  const env = {
    ...syntheticEnv(),
    DATABASE_URL: 'postgres://private-secret@production.example',
  };
  assert.throws(
    () => requireBudgetTestEnvironment(env),
    (error) => {
      assert.equal(error.code, 'CONFLICTING_CONNECTION_CONFIGURATION');
      assert.equal(String(error).includes('private-secret'), false);
      assert.equal(String(error).includes('production.example'), false);
      return true;
    },
  );
});

test('T002 every required field is fail-closed when missing, without invoking any executor', () => {
  for (const key of Object.keys(syntheticEnv())) {
    const env = syntheticEnv();
    delete env[key];
    let calls = 0;
    assert.throws(
      () =>
        runBudgetSuite('integration', env, () => {
          calls++;
        }),
      key,
    );
    assert.equal(calls, 0, key);
  }
});

test('T004 executable runner blocks integration and worker before importing absent infrastructure', () => {
  const runner = new URL('../../support/budgets/run.js', import.meta.url);
  for (const mode of ['integration', 'worker']) {
    const result = spawnSync(process.execPath, [runner.pathname, mode], {
      env: { NODE_ENV: 'test' },
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(result.status, 20);
    assert.match(
      result.stderr,
      mode === 'contract'
        ? /BUDGET_SUITE_NOT_IMPLEMENTED/
        : /EXPLICIT_OPT_IN_REQUIRED/,
    );
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('ERR_MODULE_NOT_FOUND'), false);
  }
});

test('T007 declarative opt-in alone still blocks schema before database imports/connections', () => {
  const runner = new URL('../../support/budgets/run.js', import.meta.url);
  const result = spawnSync(process.execPath, [runner.pathname, 'integration'], {
    env: { ...syntheticEnv(), PATH: process.env.PATH },
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 20);
  assert.match(result.stderr, /BUDGET_INTEGRATION_SCENARIO_REQUIRED/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /ECONNREFUSED|password authentication|ERR_MODULE_NOT_FOUND/,
  );
});
