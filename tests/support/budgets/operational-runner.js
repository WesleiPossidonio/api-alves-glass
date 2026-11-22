import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { verify } from './verify-resources.js';
import {
  containerBase,
  docker,
  execute,
  envText,
  isMain,
  privatePath,
  save,
} from './operational-common.js';

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      manifest: { type: 'string' },
      scenario: { type: 'string' },
      'approve-fixtures': { type: 'boolean' },
      'approve-schema': { type: 'boolean' },
    },
  });
  const scenario = values.scenario;
  assert.ok(
    [
      'fresh',
      'upgrade',
      'migrated',
      'all',
      'preflight',
      'worker',
      'unit',
      'contract',
      't061',
      'prepare-schema',
    ].includes(scenario),
  );
  if (['fresh', 'upgrade', 'all'].includes(scenario))
    assert.equal(values['approve-fixtures'], true);
  if (scenario === 'prepare-schema')
    assert.equal(values['approve-schema'], true);
  const manifest = resolve(values.manifest),
    data = await verify(manifest);
  const envPath = join(dirname(manifest), 'app.env');
  await privatePath(envPath);
  const env = Object.fromEntries(
    (await readFile(envPath, 'utf8'))
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        assert.ok(index > 0);
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  assert.equal(env.BUDGETS_TEST_RUN_ID, data.runId);
  assert.equal(env.DB_DATABASE, data.database);
  assert.equal(env.MINIO_BUCKET_PRIVATE, data.bucket);
  const evidence = join(
    dirname(manifest),
    `t022-ops-${randomBytes(6).toString('hex')}`,
  );
  await mkdir(evidence, { mode: 0o700 });
  const base = [
    ...containerBase(data.network),
    '--env-file',
    envPath,
    '-e',
    'BUDGETS_GATE_EXECUTION_APPROVED=1',
  ];
  async function run(name, command, overrides = {}) {
    const privateEnv = join(evidence, `${name}.env`);
    await save(privateEnv, envText(overrides), true);
    const result = await execute(
      'docker',
      [
        ...base,
        '--env-file',
        privateEnv,
        '--entrypoint',
        'node',
        data.apiImage,
        ...command,
      ],
      { timeout: scenario === 't061' ? 180000 : 0, relay: true },
    );
    const log = join(evidence, `${name}.log`);
    await save(log, result.output);
    await save(join(evidence, `${name}.exit`), String(result.code));
    console.log(JSON.stringify({ scenario: name, exit: result.code, log }));
    return result.code;
  }
  const state = scenario === 'prepare-schema' ? 'fresh' : 'migrated';
  let code = await run('preflight', [
    '--input-type=module',
    '-e',
    `import {openBudgetGateEnvironment} from './tests/support/budgets/gate-environment.js';const e=await openBudgetGateEnvironment(process.env,'${state}');await e.db.close();console.log('BUDGET_REMOTE_PREFLIGHT_OK');`,
  ]);
  if (code) return 20;
  if (scenario === 'preflight') return 0;
  if (scenario === 't061') {
    return run(
      't061',
      [
        '--test',
        '--test-concurrency=1',
        'tests/integration/budgets/t061-worker.integration.test.js',
        'tests/integration/budgets/resource-pressure.integration.test.js',
        'tests/integration/budgets/worker-bootstrap.integration.test.js',
        'tests/integration/budgets/process-kill.integration.test.js',
      ],
      { BUDGETS_WORKER_EXECUTION_APPROVED: '1' },
    );
  }
  if (scenario === 'prepare-schema') {
    // Explicit NEW empty database only. Existing CLI chain, no sync/reset or rollback campaign.
    for (const to of [
      '20261126000000-add-service-order-informational-priority.cjs',
      '20261130000000-enforce-budget-pdf-lifecycle.cjs',
    ]) {
      code = await run(`schema-${to.slice(0, 14)}`, [
        'node_modules/sequelize-cli/lib/sequelize',
        'db:migrate',
        '--env',
        'test',
        '--to',
        to,
      ]);
      if (code) return 21;
    }
    code = await run('schema-ready', [
      '--input-type=module',
      '-e',
      "import {openBudgetGateEnvironment} from './tests/support/budgets/gate-environment.js';const e=await openBudgetGateEnvironment();await e.db.close();console.log('BUDGET_MIGRATED_READY');",
    ]);
    if (code) return 20;
    data.schemaMigrationsApplied = true;
    await save(manifest, data);
    return 0;
  }
  for (const current of scenario === 'all'
    ? ['fresh', 'upgrade', 'migrated']
    : [scenario]) {
    const overrides = { BUDGETS_INTEGRATION_SCENARIO: current };
    if (['fresh', 'upgrade'].includes(current)) {
      const fixtureId = randomBytes(6).toString('hex'),
        database = `${data.database}_fixture_${fixtureId}`,
        user = env.DB_USERNAME;
      assert.match(user, /^feature005_test_[a-f0-9]{8,32}$/);
      assert.match(env.BUDGETS_TEST_IDENTITY_TOKEN, /^[a-f0-9]{64}$/);
      const digest = createHash('sha256')
        .update(env.BUDGETS_TEST_IDENTITY_TOKEN)
        .digest('hex');
      try {
        await docker(
          [
            'exec',
            '-i',
            data.postgresContainer,
            'psql',
            '-U',
            'postgres',
            '-v',
            'ON_ERROR_STOP=1',
          ],
          {
            input: `CREATE DATABASE ${database} OWNER ${user};
REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
GRANT CONNECT,TEMPORARY ON DATABASE ${database} TO ${user};
\\connect ${database}
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE,CREATE ON SCHEMA public TO ${user};
CREATE SCHEMA feature005_test_identity AUTHORIZATION postgres;
CREATE TABLE feature005_test_identity.receipt(run_id text PRIMARY KEY,token_sha256 text NOT NULL);
INSERT INTO feature005_test_identity.receipt VALUES ('${data.runId}','${digest}');
GRANT USAGE ON SCHEMA feature005_test_identity TO ${user};
GRANT SELECT ON feature005_test_identity.receipt TO ${user};`,
          },
        );
      } catch {
        return 21;
      }
      Object.assign(overrides, {
        DB_DATABASE: database,
        BUDGETS_TEST_FIXTURE_ID: fixtureId,
        BUDGETS_EMPTY_ROLLBACK_FIXTURE_APPROVED: '1',
        BUDGETS_SCHEMA_EXECUTION_APPROVED: '1',
      });
      await save(join(evidence, `${current}-identity.json`), {
        database,
        fixtureId,
        runId: data.runId,
      });
    }
    if (current === 'worker') overrides.BUDGETS_WORKER_EXECUTION_APPROVED = '1';
    code = await run(
      current,
      [
        'tests/support/budgets/run.js',
        ['unit', 'contract', 'worker'].includes(current)
          ? current
          : 'integration',
      ],
      overrides,
    );
    if (code) return [20, 21, 22].includes(code) ? code : 21;
  }
  return 0;
}
if (isMain(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch {
    console.error('BUDGET_OPERATIONAL_PREFLIGHT_FAILED');
    process.exitCode = 20;
  }
}
