import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireBudgetTestEnvironment } from './environment.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function testFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('SYMLINK_TEST_PATH_REJECTED');
      return entry.isDirectory()
        ? testFiles(path)
        : entry.name.endsWith('.test.js')
          ? [path]
          : [];
    })
    .sort();
}

export function runBudgetSuite(mode, env = process.env, execute = spawnSync) {
  if (!['unit', 'contract', 'integration', 'worker'].includes(mode))
    throw new Error('UNKNOWN_BUDGET_SUITE');
  const external = ['integration', 'worker'].includes(mode);
  // Must precede discovery/import/spawn of any test, client or worker.
  if (external) requireBudgetTestEnvironment(env);
  else if (env.NODE_OPTIONS || env.DOTENV_CONFIG_PATH)
    throw new Error('IMPLICIT_CONFIGURATION_NOT_ALLOWED');

  const worker = join(root, 'src/app/services/BudgetPdfCleanupWorker.js');
  const folders = {
    unit: 'tests/unit/budgets',
    contract: 'tests/contracts/budgets',
    integration: 'tests/integration/budgets',
  };
  let files =
    mode === 'worker'
      ? existsSync(worker)
        ? [worker]
        : []
      : testFiles(join(root, folders[mode]));
  if (files.length === 0)
    throw new Error(
      mode === 'worker'
        ? 'BUDGET_WORKER_NOT_IMPLEMENTED_T018'
        : 'BUDGET_SUITE_NOT_IMPLEMENTED',
    );
  if (mode === 'worker' && env.BUDGETS_WORKER_EXECUTION_APPROVED !== '1')
    throw new Error('BUDGET_WORKER_EXECUTION_APPROVAL_REQUIRED');
  if (mode === 'integration') {
    if (
      !['fresh', 'upgrade', 'migrated'].includes(
        env.BUDGETS_INTEGRATION_SCENARIO,
      )
    )
      throw new Error('BUDGET_INTEGRATION_SCENARIO_REQUIRED');
    if (env.BUDGETS_GATE_EXECUTION_APPROVED !== '1')
      throw new Error('BUDGET_GATE_EXECUTION_APPROVAL_REQUIRED');
    if (
      env.BUDGETS_INTEGRATION_SCENARIO !== 'migrated' &&
      (!env.BUDGETS_TEST_FIXTURE_ID ||
        env.BUDGETS_SCHEMA_EXECUTION_APPROVED !== '1')
    )
      throw new Error('BUDGET_SCHEMA_FIXTURE_REQUIRED');
    files = files.filter((path) =>
      env.BUDGETS_INTEGRATION_SCENARIO === 'migrated'
        ? !path.endsWith('/schema.postgres.test.js')
        : path.endsWith('/schema.postgres.test.js'),
    );
  }
  const childEnv = {
    PATH: env.PATH,
    HOME: env.HOME,
    NODE_ENV: 'test',
    TZ: 'UTC',
  };
  if (external) {
    for (const key of [
      'RUN_BUDGETS_INTEGRATION',
      'BUDGETS_TEST_RUN_ID',
      'BUDGETS_TEST_NETWORK',
      'BUDGETS_TEST_POSTGRES_VOLUME',
      'BUDGETS_TEST_MINIO_VOLUME',
      'DB_HOST',
      'DB_PORT',
      'DB_DATABASE',
      'DB_USERNAME',
      'DB_PASSWORD',
      'MINIO_ENDPOINT',
      'MINIO_PORT',
      'MINIO_USE_SSL',
      'MINIO_BUCKET_PRIVATE',
      'MINIO_ACCESS_KEY',
      'MINIO_SECRET_KEY',
      'BUDGETS_SCHEMA_EXECUTION_APPROVED',
      'BUDGETS_TEST_IDENTITY_TOKEN',
      'BUDGETS_TEST_POSTGRES_MAJOR',
      'BUDGETS_GATE_EXECUTION_APPROVED',
      'BUDGETS_WORKER_EXECUTION_APPROVED',
      'BUDGETS_WORKER_RUN_ONCE',
      'BUDGETS_TEST_DELETE_PROXY_PORT',
      'BUDGETS_RECONCILER_ACTOR_ID',
      'BUDGETS_INTEGRATION_SCENARIO',
      'BUDGETS_TEST_FIXTURE_ID',
      'BUDGETS_EMPTY_ROLLBACK_FIXTURE_APPROVED',
    ])
      childEnv[key] = env[key];
  }
  const args =
    mode === 'worker'
      ? files
      : mode === 'integration'
        ? [join(root, 'tests/support/budgets/integration-cli.js')]
        : ['--test', '--test-concurrency=1', ...files];
  const result = execute(process.execPath, args, {
    cwd: root,
    env: childEnv,
    stdio: 'inherit',
    shell: false,
  });
  return result.error || result.signal
    ? 21
    : result.status === 0
      ? 0
      : external
        ? (result.status ?? 21)
        : 22;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv[2] === 'worker') {
      requireBudgetTestEnvironment(process.env);
      const { runWorkerCli } = await import('./worker-cli.js');
      process.exitCode = await runWorkerCli();
    } else process.exitCode = runBudgetSuite(process.argv[2]);
  } catch (error) {
    // Only fixed error codes, never input/credentials or stack traces.
    console.error(
      error.code ??
        (error.message.startsWith('BUDGET_') ||
        error.message === 'IMPLICIT_CONFIGURATION_NOT_ALLOWED'
          ? error.message
          : 'BUDGET_RUNNER_BLOCKED'),
    );
    process.exitCode = 20;
  }
}
