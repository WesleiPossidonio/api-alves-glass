import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxRssBytes } from '../../../src/app/services/BudgetPdfValidationService.js';

test('qpdf proc read ESRCH/ENOENT only resolves RSS0 after independent PID absence proof', async () => {
  for (const code of ['ESRCH', 'ENOENT']) {
    const read = async () => {
      throw Object.assign(new Error('gone'), { code });
    };
    assert.equal(
      await linuxRssBytes(123, read, () => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }),
      0,
    );
    await assert.rejects(
      linuxRssBytes(123, read, () => true),
      { code },
    );
    await assert.rejects(
      linuxRssBytes(123, read, () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      }),
      { code },
    );
  }
  await assert.rejects(
    linuxRssBytes(123, async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }),
    { code: 'EACCES' },
  );
  await assert.rejects(
    linuxRssBytes(123, async (path) =>
      path.endsWith('statm') ? '1 1 0 0 0 0 0' : 'State:\tR (running)\n',
    ),
    { code: 'validatorFailed' },
  );
  assert.equal(await linuxRssBytes(123, async () => 'State:\tZ (zombie)\n'), 0);
});
test('qpdf exiting state R without VmRSS requires independently zero statm, not missing metric alone', async () => {
  assert.equal(
    await linuxRssBytes(123, async (path) =>
      path.endsWith('statm') ? '0 0 0 0 0 0 0\n' : 'State:\tR (running)\n',
    ),
    0,
  );
});
