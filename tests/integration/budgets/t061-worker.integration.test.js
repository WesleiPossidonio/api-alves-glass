import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Sequelize } from 'sequelize';
import { openBudgetGateEnvironment } from '../../support/budgets/gate-environment.js';
import { budgetObjectKey } from '../../../src/app/services/BudgetPdfStorageService.js';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';
import { createBudgetPdfValidationService } from '../../../src/app/services/BudgetPdfValidationService.js';
import { BudgetPdfObjectRepositoryClient } from '../../../src/app/repositories/BudgetPdfObjectRepository.js';
import BudgetPdfObject from '../../../src/app/models/BudgetPdfObject.js';

const workerPath = new URL('../../support/budgets/run.js', import.meta.url)
  .pathname;
async function worker(extra = {}) {
  const child = spawn(process.execPath, [workerPath, 'worker'], {
    env: { ...process.env, BUDGETS_WORKER_RUN_ONCE: '1', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 100000) child.kill('SIGKILL');
    });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  try {
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status, reason) => resolve([status, reason]));
    });
    assert.equal(signal, null, 'worker exceeded hard deadline');
    assert.doesNotMatch(output, /password|secret|\.pdf|at file:|Sequelize/i);
    return { code, output };
  } finally {
    clearTimeout(timer);
  }
}

test(
  'T061 constrained child RSS, scarce PostgreSQL pool and real five-second lock timeout',
  { timeout: 45000 },
  async () => {
    const connection = await openBudgetGateEnvironment();
    const root = await mkdtemp(join(tmpdir(), 't061-child-'));
    const limited = new Sequelize(
      process.env.DB_DATABASE,
      process.env.DB_USERNAME,
      process.env.DB_PASSWORD,
      {
        dialect: 'postgres',
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        logging: false,
        pool: { max: 1, min: 0, acquire: 5000 },
        dialectOptions: {
          statement_timeout: 12000,
          connectionTimeoutMillis: 5000,
        },
      },
    );
    const started = Date.now();
    let peakChildRss = 0;
    try {
      // The executable is a test-only real subprocess, not a fake PDF validator
      // response. Tighten the existing watchdog ceiling; never raise it.
      const executable = join(root, 'child.js');
      await writeFile(
        executable,
        `const bytes=Buffer.alloc(32*1024*1024,1);
setInterval(()=>{if(bytes[0]!==1)process.exit(1)},1000);
`,
        { mode: 0o700 },
      );
      // /tmp is noexec; execute Node from the immutable image and read the script.
      const spawnChild = (_executable, args, options) => {
        const child = spawn(process.execPath, [executable, ...args], options);
        const monitor = setInterval(async () => {
          try {
            const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
            peakChildRss = Math.max(
              peakChildRss,
              Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0) * 1024,
            );
          } catch (error) {
            if (!['ENOENT', 'ESRCH'].includes(error.code))
              clearInterval(monitor);
          }
        }, 5);
        child.once('close', () => clearInterval(monitor));
        return child;
      };
      const validation = createBudgetPdfValidationService({
        spawn: spawnChild,
        executable: '/usr/bin/qpdf',
        temporaryRoot: root,
        limits: {
          maxRssBytes: 12 * 1024 * 1024,
          timeoutMs: 3000,
          rssPollMs: 10,
        },
      });
      const childStart = Date.now();
      await assert.rejects(validation.validate(buildPdf()), {
        code: 'validatorFailed',
      });
      const childMs = Date.now() - childStart;
      assert.ok(childMs < 3000);
      assert.ok(peakChildRss > 12 * 1024 * 1024);
      assert.deepEqual((await readdir(root)).sort(), ['child.js']);

      const poolStart = Date.now();
      const one = limited.transaction(async (transaction) => {
        const [[row]] = await limited.query('SELECT pg_backend_pid() AS pid', {
          transaction,
        });
        await new Promise((resolve) => setTimeout(resolve, 320));
        return row.pid;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const two = limited.query('SELECT pg_backend_pid() AS pid');
      const [pid, [other]] = await Promise.all([one, two]);
      assert.equal(pid, other[0].pid);
      const poolWaitMs = Date.now() - poolStart;
      assert.ok(poolWaitMs >= 290 && poolWaitMs < 5000);

      BudgetPdfObject.init(connection.db);
      const repository = new BudgetPdfObjectRepositoryClient(BudgetPdfObject);
      const owner = randomUUID();
      const holder = await limited.transaction();
      let lockWaitMs;
      try {
        await limited.query(
          `SELECT pg_advisory_xact_lock(hashtextextended(:key,0))`,
          {
            transaction: holder,
            replacements: { key: `budget-pdf:${owner}` },
          },
        );
        const lockStart = Date.now();
        await assert.rejects(
          repository.transaction((transaction) =>
            repository.lockOwned(
              { id: randomUUID(), owner_budget_id: owner },
              transaction,
            ),
          ),
          (error) =>
            error.parent?.code === '55P03' || error.original?.code === '55P03',
        );
        lockWaitMs = Date.now() - lockStart;
        assert.ok(lockWaitMs >= 4700 && lockWaitMs < 8000);
      } finally {
        await holder.rollback();
      }
      console.log(
        JSON.stringify({
          t061ResourceMetrics: {
            childRejectionMs: childMs,
            peakObservedChildRssBytes: peakChildRss,
            childRssLimitBytes: 12 * 1024 * 1024,
            poolMax: 1,
            poolWaitMs,
            advisoryLockTimeoutMs: lockWaitMs,
            processRssBytes: process.memoryUsage().rss,
            cgroupMemoryPeakBytes: Number(
              await readFile('/sys/fs/cgroup/memory.peak', 'utf8'),
            ),
            durationMs: Date.now() - started,
          },
        }),
      );
    } finally {
      await limited.close();
      await connection.db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'T061 real CLI: 27 exclusive jobs in bounded batches and ten failed DELETE transports',
  { timeout: 240000 },
  async () => {
    const connection = await openBudgetGateEnvironment();
    const { rows, client, target, db } = connection;
    const actor = randomUUID();
    const ids = [];
    const started = Date.now();
    let failures = 0;
    let failedKey;
    const proxy = http.createServer((request, response) => {
      if (
        request.method !== 'DELETE' ||
        !failedKey ||
        !request.url?.includes(failedKey)
      ) {
        response.writeHead(503).end();
        return;
      }
      failures++;
      request.resume();
      request.once('end', () => request.socket.destroy());
    });
    const rss = () => process.memoryUsage().rss;
    let maxRss = rss();
    const sample = setInterval(() => {
      maxRss = Math.max(maxRss, rss());
    }, 50);
    try {
      await rows(
        `INSERT INTO public.users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at)
       VALUES (:actor,:actor,:email,'not-a-password','user','active','',now(),now())`,
        { actor, email: `${actor}@example.invalid` },
      );
      async function fixture() {
        const id = randomUUID(),
          owner = randomUUID();
        const key = budgetObjectKey(owner, id);
        await rows(
          `INSERT INTO public.budget_pdf_objects
         (id,owner_budget_id,bucket,object_key,created_by,state,validity_date,lease_token,lease_until,created_at,updated_at)
         VALUES (:id,:owner,:bucket,:key,:actor,'UPLOADING','2027-01-01',:token,now()+interval '2 minutes',now()-interval '2 hours',now())`,
          { id, owner, bucket: target.bucket, key, actor, token: randomUUID() },
        );
        ids.push({ id, key });
        await client.putObject(
          target.bucket,
          key,
          Buffer.from('T061 exclusive synthetic PDF object'),
        );
        await rows(
          `UPDATE public.budget_pdf_objects SET state='CLEANUP_PENDING',
         lease_token=NULL,lease_until=NULL,
         next_attempt_at='1900-01-01' WHERE id=:id AND state='UPLOADING'`,
          { id },
        );
        return { id, key };
      }
      // Create all 27 before launching the worker: the claim limit is 25.
      for (let i = 0; i < 27; i++) await fixture();
      const first = await worker();
      assert.equal(first.code, 0, first.output);
      assert.match(first.output, /"completed":25/);
      let status = await rows(
        `SELECT state,count(*)::integer AS count FROM public.budget_pdf_objects
       WHERE created_by=:actor GROUP BY state`,
        { actor },
      );
      assert.equal(status.find((r) => r.state === 'REMOVED')?.count, 25);
      assert.equal(status.find((r) => r.state === 'CLEANUP_PENDING')?.count, 2);
      const second = await worker();
      assert.equal(second.code, 0, second.output);
      assert.match(second.output, /"completed":2/);
      const [batch] = await rows(
        `SELECT count(*)::integer AS total,
                count(*) FILTER (WHERE state='REMOVED' AND attempts=1
                  AND lease_token IS NULL AND lease_until IS NULL)::integer AS once
         FROM public.budget_pdf_objects WHERE created_by=:actor`,
        { actor },
      );
      assert.deepEqual(batch, { total: 27, once: 27 });
      for (const { key } of ids)
        await assert.rejects(client.statObject(target.bucket, key), (error) =>
          ['NotFound', 'NoSuchKey'].includes(error.code),
        );
      const stable = await worker();
      assert.equal(stable.code, 0, stable.output);
      assert.match(stable.output, /"completed":0/);

      const failed = await fixture();
      failedKey = failed.key;
      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const port = String(proxy.address().port);
      const delays = [];
      for (let attempt = 1; attempt <= 10; attempt++) {
        const result = await worker({ BUDGETS_TEST_DELETE_PROXY_PORT: port });
        assert.equal(result.code, 21, result.output);
        assert.match(result.output, /BUDGET_WORKER_EXECUTION_FAILED/);
        assert.match(result.output, /budgetCleanupBacklogOverOneHour/);
        if (attempt === 10)
          assert.match(result.output, /budgetCleanupTenErrors/);
        const [row] = await rows(
          `SELECT state,attempts,last_error_code,lease_token,lease_until,
                extract(epoch FROM (next_attempt_at - now()))*1000 AS wait_ms
         FROM public.budget_pdf_objects WHERE id=:id`,
          { id: failed.id },
        );
        assert.equal(row.state, 'CLEANUP_PENDING');
        assert.equal(row.attempts, attempt);
        assert.equal(row.last_error_code, 'storageUnavailable');
        assert.equal(row.lease_token, null);
        assert.equal(row.lease_until, null);
        assert.ok(Number(row.wait_ms) > 0);
        delays.push(Math.round(Number(row.wait_ms)));
        assert.ok(await client.statObject(target.bucket, failed.key));
        if (attempt < 10)
          await rows(
            `UPDATE public.budget_pdf_objects SET next_attempt_at='1900-01-01'
                    WHERE id=:id AND state='CLEANUP_PENDING' AND attempts=:attempt`,
            { id: failed.id, attempt },
          );
      }
      assert.equal(failures, 10);
      // Backlog alert is emitted by the CLI after a successful tick. Retry ticks
      // emit it before the supervisor-visible error; both events are sanitized.
      const alert = await worker();
      assert.equal(alert.code, 0, alert.output);
      assert.match(alert.output, /budgetCleanupBacklogOverOneHour/);
      assert.match(alert.output, /budgetCleanupTenErrors/);
      await rows(
        `UPDATE public.budget_pdf_objects SET next_attempt_at='1900-01-01'
                WHERE id=:id AND state='CLEANUP_PENDING'`,
        { id: failed.id },
      );
      const recovered = await worker();
      assert.equal(recovered.code, 0, recovered.output);
      assert.match(recovered.output, /"completed":1/);
      const [final] = await rows(
        'SELECT state,attempts,lease_token,lease_until FROM public.budget_pdf_objects WHERE id=:id',
        { id: failed.id },
      );
      assert.equal(final.state, 'REMOVED');
      assert.equal(final.attempts, 11);
      assert.equal(final.lease_token, null);
      assert.equal(final.lease_until, null);
      await assert.rejects(
        client.statObject(target.bucket, failed.key),
        (error) => ['NotFound', 'NoSuchKey'].includes(error.code),
      );
      const [locks] = await rows(
        `SELECT count(*)::integer AS count FROM pg_locks
       WHERE locktype='advisory' AND granted AND pid=pg_backend_pid()`,
      );
      assert.equal(locks.count, 0);
      console.log(
        JSON.stringify({
          t061Metrics: {
            jobs: 28,
            firstBatch: 25,
            secondBatch: 2,
            failedDeletes: failures,
            backoffMs: delays,
            attemptsAfterRecovery: final.attempts,
            remainingFixtureObjects: 0,
            heldAdvisoryLocks: locks.count,
            peakHarnessRssBytes: maxRss,
            cgroupMemoryCurrentBytes: Number(
              await readFile('/sys/fs/cgroup/memory.current', 'utf8'),
            ),
            durationMs: Date.now() - started,
          },
        }),
      );
    } finally {
      clearInterval(sample);
      proxy.closeAllConnections();
      if (proxy.listening) await new Promise((resolve) => proxy.close(resolve));
      await db.close();
    }
  },
);
