import test from 'node:test';
import assert from 'node:assert/strict';
import { matrixFixture } from '../../support/budgets/matrix-fixture.js';
import { transportFault } from '../../support/budgets/transport-fault.js';
import { BudgetPdfStorageServiceClient } from '../../../src/app/services/BudgetPdfStorageService.js';
import { publicBudgetError } from '../../../src/app/services/BudgetContractService.js';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';

test('T022 transport interrupts real signed MinIO PUT/GET/Range', async (t) => {
  const f = await matrixFixture(),
    proxy = await transportFault();
  const adapter = new BudgetPdfStorageServiceClient({
    client: proxy.client,
    repository: f.objects,
    timeoutMs: 500,
    streamMs: 2000,
  });
  try {
    for (const mode of ['before', 'after'])
      await t.test(
        `PUT socket interrupted ${mode} external commit`,
        async () => {
          const item = await f.intent({ adapter });
          const fault = proxy.arm('PUT', mode);
          const work = adapter.upload(item.proof, item.token);
          await fault.hit;
          await assert.rejects(work, (error) => {
            assert.deepEqual(publicBudgetError(error), {
              status: 503,
              body: { error: 'storageUnavailable' },
            });
            return true;
          });
          const exists = await f.storage.stat(item.proof);
          assert.equal(Boolean(exists), mode === 'after');
          assert.equal(
            await f.Budget.findByPk(item.proof.owner_budget_id),
            null,
          );
          assert.equal(
            (await f.ObjectModel.findByPk(item.proof.id)).state,
            'UPLOADING',
          );
          await f.orphan(item);
          await f.worker.processClaim(await f.claim(item));
          assert.equal(await f.storage.stat(item.proof), null);
        },
      );
    await t.test(
      'PUT timeout and abort remain recoverable; subsequent real PUT succeeds',
      async () => {
        for (const kind of ['timeout', 'abort']) {
          const item = await f.intent({ adapter });
          const fault = proxy.arm('PUT', 'hold');
          const controller = new AbortController();
          const work = adapter.upload(item.proof, item.token, {
            signal: controller.signal,
          });
          await fault.hit;
          if (kind === 'abort') controller.abort();
          await assert.rejects(work, { code: 'storageUnavailable' });
          fault.release();
          await f.orphan(item);
          await f.worker.processClaim(await f.claim(item));
          assert.equal(await f.storage.stat(item.proof), null);
        }
        const recovered = await f.intent({ adapter });
        await adapter.upload(recovered.proof, recovered.token);
        assert.ok(await f.storage.stat(recovered.proof));
        await f.orphan(recovered);
        await f.worker.processClaim(await f.claim(recovered));
      },
    );
    for (const range of [false, true])
      await t.test(
        `${range ? 'Range' : 'GET'} stream socket cut after real bytes, lock released only after abort`,
        async () => {
          const item = await f.attached({
            bytes: buildPdf({ size: 1024 * 1024 }),
          });
          const transaction = await f.db.transaction();
          try {
            await f.budgets.lockBudget(
              item.proof.owner_budget_id,
              transaction,
              { shared: true },
            );
            const fault = proxy.arm('GET', 'stream');
            const row = await f.ObjectModel.findByPk(item.proof.id, {
              transaction,
            });
            const stream = await adapter.get(
              row,
              range ? { start: 0, length: 65536 } : {},
            );
            const received = new Promise((resolve, reject) => {
              stream.once('data', resolve);
              stream.once('error', reject);
            });
            const failed = new Promise((resolve) =>
              stream.once('error', resolve),
            );
            await received;
            await fault.hit;
            fault.release();
            const error = await failed;
            assert.equal(publicBudgetError(error).status, 503);
            assert.equal(stream.destroyed, true);
            await transaction.commit();
            assert.ok(await f.storage.stat(item.proof));
            assert.equal(
              await f.tx((tx) => f.objects.referencesObject(item.proof.id, tx)),
              true,
            );
            assert.equal(adapter.streams, 0);
          } finally {
            if (!transaction.finished) await transaction.rollback();
          }
        },
      );
    await t.test(
      'GET caller abort and streaming deadline close actual streams and recover capacity',
      async () => {
        const item = await f.attached({
          bytes: buildPdf({ size: 1024 * 1024 }),
        });
        for (const kind of ['abort', 'timeout']) {
          const fault = proxy.arm('GET', 'stream'),
            controller = new AbortController();
          const stream = await adapter.get(
            await f.ObjectModel.findByPk(item.proof.id),
            { signal: controller.signal },
          );
          const failed = new Promise((resolve) =>
            stream.once('error', resolve),
          );
          stream.resume();
          await fault.hit;
          if (kind === 'abort') controller.abort();
          const error = await failed;
          assert.equal(error.code, 'storageUnavailable');
          fault.release();
          assert.equal(adapter.streams, 0);
          assert.ok(await f.storage.stat(item.proof));
        }
        const recovered = await adapter.get(
          await f.ObjectModel.findByPk(item.proof.id),
        );
        let size = 0;
        for await (const chunk of recovered) size += chunk.length;
        assert.equal(size, 1024 * 1024);
        assert.equal(adapter.streams, 0);
      },
    );
  } finally {
    await proxy.close();
    assert.equal(proxy.openSockets, 0);
    await f.db.close();
  }
});
