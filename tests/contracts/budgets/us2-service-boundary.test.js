import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { BudgetPdfPublishService } from '../../../src/app/services/BudgetPdfPublishService.js';
import { ClientBudgetPdfService } from '../../../src/app/services/ClientBudgetPdfService.js';

test('T032 publication service rejects missing revision and unknown transport fields; no HTTP claim', async () => {
  const service = new BudgetPdfPublishService(),
    id = randomUUID(),
    actor = { id: randomUUID(), type: 'user' };
  await assert.rejects(
    service.publish(id, { pendingDocumentId: randomUUID() }, actor),
    { code: 'revisionRequired', status: 428 },
  );
  await assert.rejects(
    service.publish(
      id,
      { pendingDocumentId: randomUUID(), bucket: 'external' },
      actor,
    ),
    { code: 'validation', status: 400 },
  );
});
test('T035 portal client identity cannot be selected by query; no early routes or physical publication I/O', async () => {
  const portal = new ClientBudgetPdfService();
  await assert.rejects(
    portal.list(
      { clientId: randomUUID() },
      { id: randomUUID(), type: 'client' },
    ),
    { code: 'validation' },
  );
  const root = new URL('../../../', import.meta.url);
  const routes = await readFile(new URL('src/routes.js', root), 'utf8');
  assert.doesNotMatch(
    routes,
    /ClientBudgetPdfController|BudgetPdfStreamService/,
  );
  const source = await readFile(
    new URL('src/app/services/BudgetPdfPublishService.js', root),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /\.upload\(|\.remove\(|putObject\(|removeObject\(|presigned/i,
  );
});
