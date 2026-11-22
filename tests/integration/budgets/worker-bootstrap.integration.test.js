import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openBudgetGateEnvironment } from '../../support/budgets/gate-environment.js';
import { budgetObjectKey } from '../../../src/app/services/BudgetPdfStorageService.js';

async function launch(env, signal, entry = 'runner') {
  const binary = entry === 'package' ? 'yarn' : process.execPath;
  const args =
    entry === 'package'
      ? ['budgets:cleanup-worker']
      : entry === 'direct'
        ? [
            new URL(
              '../../../src/app/services/BudgetPdfCleanupWorker.js',
              import.meta.url,
            ).pathname,
          ]
        : entry === 'integration'
          ? [
              new URL(
                '../../support/budgets/integration-cli.js',
                import.meta.url,
              ).pathname,
            ]
          : [
              new URL('../../support/budgets/run.js', import.meta.url).pathname,
              'worker',
            ];
  const child = spawn(binary, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let output = '';
  let sent = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (signal && !sent && output.includes('budgetWorkerTick')) {
      sent = true;
      child.kill(signal);
    }
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve(signal ? 128 : status));
  });
  clearTimeout(timer);
  return { code, output };
}

test('T022 actual CLI/runner worker: remote preflight, persisted cleanup, SIGTERM/SIGINT and negative identities', async (t) => {
  const connection = await openBudgetGateEnvironment();
  const { rows, client, target } = connection;
  const actor = randomUUID(),
    object = randomUUID(),
    owner = randomUUID();
  const key = budgetObjectKey(owner, object);
  try {
    await rows(
      `INSERT INTO public.users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at) VALUES (:actor,:actor,:email,'not-a-password','user','active','',now(),now())`,
      { actor, email: `${actor}@example.invalid` },
    );
    await rows(
      `INSERT INTO public.budget_pdf_objects(id,owner_budget_id,bucket,object_key,created_by,state,validity_date,lease_token,lease_until) VALUES (:object,:owner,:bucket,:key,:actor,'UPLOADING','2027-01-01',:token,now()+interval '2 minutes')`,
      { object, owner, bucket: target.bucket, key, actor, token: randomUUID() },
    );
    await client.putObject(
      target.bucket,
      key,
      Buffer.from('T022 CLI exclusive cleanup object'),
    );
    await rows(
      "UPDATE public.budget_pdf_objects SET state='CLEANUP_PENDING',lease_token=NULL,lease_until=NULL WHERE id=:object",
      { object },
    );
    // A migrated run preserves old recoverable jobs; a single-tick CLI test
    // must place its own fixture in the bounded 25-claim batch.
    await rows(
      "UPDATE public.budget_pdf_objects SET next_attempt_at='2000-01-01' WHERE id=:object AND state='CLEANUP_PENDING'",
      { object },
    );
    const env = {
      ...process.env,
      BUDGETS_WORKER_EXECUTION_APPROVED: '1',
      BUDGETS_RECONCILER_ACTOR_ID: actor,
    };
    await t.test(
      'real package script performs cleanup and explicit single-tick shutdown',
      async () => {
        const result = await launch(
          { ...env, BUDGETS_WORKER_RUN_ONCE: '1' },
          null,
          'package',
        );
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /budgetWorkerReady/);
        assert.match(result.output, /budgetWorkerStopped/);
        assert.equal(
          (
            await rows(
              'SELECT state FROM public.budget_pdf_objects WHERE id=:object',
              { object },
            )
          )[0].state,
          'REMOVED',
        );
        await assert.rejects(client.statObject(target.bucket, key), (error) =>
          ['NotFound', 'NoSuchKey'].includes(error.code),
        );
      },
    );
    await t.test('runner receives SIGTERM and exits zero', async () => {
      const result = await launch(env, 'SIGTERM');
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /budgetWorkerStopped/);
    });
    await t.test(
      'SIGINT without technical actor is controlled and explicit',
      async () => {
        const noActor = { ...env };
        delete noActor.BUDGETS_RECONCILER_ACTOR_ID;
        const result = await launch(noActor, 'SIGINT');
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /"technicalActor":false/);
        assert.match(result.output, /budgetWorkerStopped/);
      },
    );
    await t.test(
      'direct service entrypoint shuts down safely too',
      async () => {
        const result = await launch(env, 'SIGTERM', 'direct');
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /budgetWorkerStopped/);
      },
    );
    await t.test(
      'fresh/upgrade preflight rejects migrated main database before any migration',
      async () => {
        const before = await rows(
          'SELECT name FROM public."SequelizeMeta" ORDER BY name',
        );
        for (const scenario of ['fresh', 'upgrade']) {
          const result = await launch(
            { ...env, BUDGETS_INTEGRATION_SCENARIO: scenario },
            null,
            'integration',
          );
          assert.equal(result.code, 20, result.output);
          assert.match(result.output, /BUDGET_INTEGRATION_PREFLIGHT_FAILED/);
        }
        assert.deepEqual(
          await rows('SELECT name FROM public."SequelizeMeta" ORDER BY name'),
          before,
        );
      },
    );
    await t.test(
      'negative opt-in/version/token/credentials/actor cannot reach ready; sanitized failure',
      async () => {
        for (const patch of [
          { NODE_ENV: 'production' },
          { BUDGETS_WORKER_EXECUTION_APPROVED: '0' },
          { BUDGETS_TEST_POSTGRES_MAJOR: '16' },
          { BUDGETS_TEST_IDENTITY_TOKEN: 'a'.repeat(64) },
          { DB_PASSWORD: 'wrong-password-should-not-be-logged' },
          { MINIO_SECRET_KEY: 'wrong-secret-should-not-be-logged' },
          { BUDGETS_RECONCILER_ACTOR_ID: randomUUID() },
        ]) {
          const result = await launch({ ...env, ...patch });
          assert.equal(result.code, 20, result.output);
          assert.doesNotMatch(
            result.output,
            /budgetWorkerReady|password-should|secret-should|Sequelize|AssertionError| at /,
          );
        }
      },
    );
  } finally {
    await connection.db.close();
  }
});
