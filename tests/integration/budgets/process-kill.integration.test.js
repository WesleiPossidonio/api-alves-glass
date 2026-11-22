import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { matrixFixture } from '../../support/budgets/matrix-fixture.js';

test('T022 real SIGKILL after DELETE before DB CAS, restart actual worker and durable recovery', async () => {
  const f = await matrixFixture();
  let child;
  try {
    const item = await f.intent();
    await f.storage.upload(item.proof, item.token);
    await f.orphan(item);
    const job = await f.claim(item);
    child = fork(
      new URL('../../support/budgets/kill-executor.js', import.meta.url),
      [],
      {
        env: { ...process.env, BUDGETS_KILL_CLAIM: JSON.stringify(job) },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    const message = await Promise.race([
      once(child, 'message').then(([message]) => message),
      once(child, 'exit').then(() => {
        throw new Error('KILL_EXECUTOR_EXITED_BEFORE_CHECKPOINT');
      }),
    ]);
    clearTimeout(timeout);
    assert.equal(message.event, 'externalDeleteConfirmedBeforeDatabaseCAS');
    assert.equal(message.id, item.proof.id);
    assert.equal(await f.storage.stat(item.proof), null);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
    assert.equal(
      (await f.ObjectModel.findByPk(item.proof.id)).state,
      'CLEANING',
    );
    // Explicit virtual lease expiry after confirmed process death; no 2min sleep.
    await f.rows(
      "UPDATE public.budget_pdf_objects SET lease_until=clock_timestamp()-interval '1 second' WHERE id=:id",
      { id: item.proof.id },
    );
    const worker = spawn(
      process.execPath,
      [
        new URL('../../support/budgets/run.js', import.meta.url).pathname,
        'worker',
      ],
      {
        env: {
          ...process.env,
          BUDGETS_WORKER_EXECUTION_APPROVED: '1',
          BUDGETS_WORKER_RUN_ONCE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    worker.stdout.on('data', (chunk) => (output += chunk));
    worker.stderr.on('data', (chunk) => (output += chunk));
    const [code] = await once(worker, 'exit');
    assert.equal(code, 0, output);
    assert.match(output, /budgetWorkerStopped/);
    assert.equal(
      (await f.ObjectModel.findByPk(item.proof.id)).state,
      'REMOVED',
    );
    assert.equal(await f.storage.stat(item.proof), null);
    assert.equal(await f.worker.processClaim(job), 'stale');
    assert.equal(
      await f.tx((tx) => f.objects.referencesObject(item.proof.id, tx)),
      false,
    );
    console.log(
      JSON.stringify({
        checkpoint: message.event,
        signal,
        registryAfterRestart: 'REMOVED',
        oldTokenFenced: true,
        objectAbsent: true,
      }),
    );
  } finally {
    if (child?.exitCode === null && child?.signalCode === null)
      child.kill('SIGKILL');
    await f.db.close();
  }
});
