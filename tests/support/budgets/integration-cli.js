import { spawn } from 'node:child_process';
import { openBudgetGateEnvironment } from './gate-environment.js';

const scenario = process.env.BUDGETS_INTEGRATION_SCENARIO;
let ready = false;
try {
  if (!['fresh', 'upgrade', 'migrated'].includes(scenario)) throw new Error();
  // Fixture names never authorize production/shared resources. Identity is
  // verified remotely before launching any migration or test file.
  const connection = await openBudgetGateEnvironment(
    process.env,
    scenario === 'migrated' ? 'migrated' : 'fresh',
  );
  await connection.db.close();
  ready = true;
  const files =
    scenario === 'migrated'
      ? [
          'foundation.integration.test.js',
          'runtime.integration.test.js',
          'worker-bootstrap.integration.test.js',
          'authorization-matrix.integration.test.js',
          'domain-isolation.integration.test.js',
          'lifecycle-matrix.integration.test.js',
          'transport-matrix.integration.test.js',
          'process-kill.integration.test.js',
          'resource-pressure.integration.test.js',
          'us1-create-read.integration.test.js',
          'us1-http.integration.test.js',
          'legacy-reconciliation.integration.test.js',
          'us2-services.integration.test.js',
          'us2-stream.integration.test.js',
          'publication-portal.integration.test.js',
          'replacement.integration.test.js',
          'deletion-recovery.integration.test.js',
          'permissions.integration.test.js',
          'authorization-races.integration.test.js',
          'validator-observation.integration.test.js',
        ]
      : ['schema.postgres.test.js'];
  const child = spawn(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      ...files.map(
        (name) =>
          new URL(`../../integration/budgets/${name}`, import.meta.url)
            .pathname,
      ),
    ],
    { env: process.env, stdio: 'inherit', shell: false },
  );
  const relay = (signal) => child.kill(signal);
  const term = () => relay('SIGTERM'),
    int = () => relay('SIGINT');
  process.on('SIGTERM', term);
  process.on('SIGINT', int);
  process.exitCode = await new Promise((resolve) => {
    child.once('error', () => resolve(21));
    child.once('exit', (code, signal) =>
      resolve(signal ? 21 : code === 0 ? 0 : 22),
    );
  });
  process.removeListener('SIGTERM', term);
  process.removeListener('SIGINT', int);
} catch {
  console.error(
    ready
      ? 'BUDGET_INTEGRATION_EXECUTION_FAILED'
      : 'BUDGET_INTEGRATION_PREFLIGHT_FAILED',
  );
  process.exitCode = ready ? 21 : 20;
}
