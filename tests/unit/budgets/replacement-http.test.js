import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BudgetPdfController } from '../../../src/app/controllers/BudgetPdfController.js';
import {
  budgetEtag,
  budgetError,
} from '../../../src/app/services/BudgetContractService.js';

test('T041 PATCH/PUT transport passes trusted actor, revision, bytes; minimal DTO and ETag', async () => {
  for (const method of ['edit', 'replace']) {
    const id = randomUUID(),
      actor = randomUUID(),
      document = randomUUID(),
      result = {
        id,
        revision: '2',
        ...(method === 'replace' ? { pendingDocumentId: document } : {}),
      };
    const controller = new BudgetPdfController({
      [method]: {
        async [method](...args) {
          assert.equal(args[0], id);
          assert.deepEqual(args[2], { id: actor, type: 'user' });
          assert.equal(args.at(-1).ifMatch, budgetEtag(id, '1'));
          if (method === 'replace') assert.equal(args[3].toString(), 'PDF');
          return result;
        },
      },
    });
    const response = {
      locals: {},
      set(key, value) {
        assert.equal(key, 'ETag');
        assert.equal(value, budgetEtag(id, '2'));
        return this;
      },
      json(body) {
        assert.deepEqual(body, result);
      },
    };
    await controller[method](
      {
        params: { id },
        body: {},
        query: {},
        userId: actor,
        actorType: 'user',
        get: () => budgetEtag(id, '1'),
        file: { buffer: Buffer.from('PDF') },
      },
      response,
    );
  }
});
test('T041 transport sanitizes 428/412/409 without implicit read', async () => {
  for (const code of [
    'revisionRequired',
    'revisionMismatch',
    'identityLocked',
    'replacementPdfRequired',
  ]) {
    const error = budgetError(code),
      controller = new BudgetPdfController({
        edit: {
          async edit() {
            throw error;
          },
        },
      });
    const response = {
      locals: {},
      status(value) {
        assert.equal(value, error.status);
        return this;
      },
      json(body) {
        assert.equal(body.error.code, code);
        assert.ok(!JSON.stringify(body).includes('stack'));
      },
    };
    await controller.edit(
      {
        query: {},
        params: { id: randomUUID() },
        body: {},
        get: () => undefined,
      },
      response,
    );
  }
});
