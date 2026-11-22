// Integration-only operational bootstrap. No production configuration fallback.
import { openBudgetGateEnvironment } from './gate-environment.js';

export async function runWorkerCli(env = process.env, factory, alertCodes) {
  let connection;
  let started = false;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    if (env.BUDGETS_WORKER_EXECUTION_APPROVED !== '1') throw new Error();
    // Declaration checks precede sockets. Read-only remote identity/schema/ACL
    // preflight precedes model initialization and all operational reads/writes.
    connection = await openBudgetGateEnvironment(env);
    if (controller.signal.aborted) return 0;
    const { default: Model } = await import(
      '../../../src/app/models/BudgetPdfObject.js'
    );
    const { BudgetPdfObjectRepositoryClient } = await import(
      '../../../src/app/repositories/BudgetPdfObjectRepository.js'
    );
    const { BudgetPdfStorageServiceClient } = await import(
      '../../../src/app/services/BudgetPdfStorageService.js'
    );
    const createBudgetPdfCleanupWorker =
      factory ??
      (await import('../../../src/app/services/BudgetPdfCleanupWorker.js'))
        .createBudgetPdfCleanupWorker;
    const cleanupAlertCodes =
      alertCodes ??
      (await import('../../../src/app/services/BudgetPdfCleanupWorker.js'))
        .cleanupAlertCodes;
    let actor = env.BUDGETS_RECONCILER_ACTOR_ID;
    if (actor) {
      const { uuid } = await import(
        '../../../src/app/services/BudgetContractService.js'
      );
      uuid(actor);
      const users = await connection.rows(
        `SELECT id FROM public.users u WHERE id=:actor AND role='user' AND status_users='active'
        AND NOT EXISTS(SELECT 1 FROM public.user_sectors WHERE user_id=u.id)
        AND NOT EXISTS(SELECT 1 FROM public.budget_commercial_managers WHERE user_id=u.id)
        AND NOT EXISTS(SELECT 1 FROM public.budget_commercial_permissions WHERE user_id=u.id)`,
        { actor },
      );
      if (users.length !== 1) throw new Error();
    }
    Model.init(connection.db);
    const repository = new BudgetPdfObjectRepositoryClient(Model);
    const storage = new BudgetPdfStorageServiceClient({ env, repository });
    // Integration-only, per-process fault transport. The production entrypoint
    // cannot opt in: the flag requires the verified isolated test environment.
    if (env.BUDGETS_TEST_DELETE_PROXY_PORT !== undefined) {
      if (
        env.NODE_ENV !== 'test' ||
        env.BUDGETS_GATE_EXECUTION_APPROVED !== '1' ||
        !/^\d{2,5}$/.test(env.BUDGETS_TEST_DELETE_PROXY_PORT) ||
        Number(env.BUDGETS_TEST_DELETE_PROXY_PORT) > 65535
      )
        throw new Error();
      const { createBudgetMinioClient } = await import(
        '../../../src/app/services/BudgetPdfStorageService.js'
      );
      const client = createBudgetMinioClient(env);
      const transport = client.transport;
      client.transport = {
        request(options, callback) {
          return transport.request(
            options.method === 'DELETE'
              ? {
                  ...options,
                  hostname: '127.0.0.1',
                  host: '127.0.0.1',
                  port: Number(env.BUDGETS_TEST_DELETE_PROXY_PORT),
                  headers: {
                    ...options.headers,
                    host: `${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`,
                  },
                }
              : options,
            callback,
          );
        },
      };
      storage.client = client;
    }
    const worker = createBudgetPdfCleanupWorker({
      repository,
      storage,
      reconcilerActorId: actor,
      alert: (code) => console.log(JSON.stringify({ event: code })),
    });
    started = true;
    console.log(
      JSON.stringify({
        event: 'budgetWorkerReady',
        technicalActor: Boolean(actor),
      }),
    );
    // Unlike the resilient daemon helper, an operational error must be visible
    // to the supervisor, not silently loop forever with a successful exit.
    const { setTimeout: sleep } = await import('node:timers/promises');
    while (!controller.signal.aborted) {
      const result = await worker.tick({ signal: controller.signal });
      // Aggregate only: no object keys, filenames, actor IDs or raw errors.
      const [health] = await connection.rows(
        `SELECT min(created_at) FILTER (WHERE state IN ('CLEANUP_PENDING','CLEANING')) AS oldest_pending_at,
                coalesce(max(attempts) FILTER (WHERE state IN ('CLEANUP_PENDING','CLEANING')),0)::integer AS max_attempts
         FROM public.budget_pdf_objects`,
      );
      for (const event of cleanupAlertCodes({
        oldestPendingAt: health.oldest_pending_at,
        maxAttempts: health.max_attempts,
      }))
        console.log(JSON.stringify({ event }));
      if (
        result.results.some((value) =>
          ['retry', 'recoveryPending'].includes(value),
        )
      )
        throw new Error();
      console.log(
        JSON.stringify({
          event: 'budgetWorkerTick',
          completed: result.results.length,
        }),
      );
      if (env.BUDGETS_WORKER_RUN_ONCE === '1') break;
      try {
        await sleep(5000, undefined, { signal: controller.signal });
      } catch {
        if (!controller.signal.aborted) throw new Error();
      }
    }
    console.log(JSON.stringify({ event: 'budgetWorkerStopped' }));
    return 0;
  } catch {
    if (started && controller.signal.aborted) return 0;
    console.error(
      started
        ? 'BUDGET_WORKER_EXECUTION_FAILED'
        : 'BUDGET_WORKER_PREFLIGHT_FAILED',
    );
    return started ? 21 : 20;
  } finally {
    if (connection) await connection.db.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
