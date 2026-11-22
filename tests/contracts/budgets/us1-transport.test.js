import test from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetHttpError,
  BudgetPdfController,
} from '../../../src/app/controllers/BudgetPdfController.js';

test('US1 HTTP error envelope maps internal codes, never forwards raw details', () => {
  for (const [internal, status, code] of [
    ['validation', 400, 'invalidInput'],
    ['notFound', 404, 'budgetNotFound'],
    ['duplicateNumber', 409, 'duplicateNumber'],
    ['invalidPdf', 422, 'invalidPdf'],
    ['storageUnavailable', 503, 'storageUnavailable'],
  ]) {
    let actual, body;
    const response = {
      locals: { budgetRequestId: 'correlation' },
      status(value) {
        actual = value;
        return this;
      },
      json(value) {
        body = value;
      },
    };
    budgetHttpError(response, {
      code: internal,
      message: 'secret',
      stack: 'secret',
    });
    assert.equal(actual, status);
    assert.deepEqual(body, {
      error: { code, message: code, requestId: 'correlation' },
    });
  }
});
test('US1 explicit cursor configuration fails closed when absent or short', async () => {
  for (const env of [{}, { BUDGETS_CURSOR_SECRET: 'short' }]) {
    const controller = new BudgetPdfController({ env });
    let status, body;
    await controller.index(
      { query: {}, userId: 'ignored', actorType: 'user' },
      {
        locals: {},
        status(value) {
          status = value;
          return this;
        },
        json(value) {
          body = value;
        },
      },
    );
    assert.equal(status, 503);
    assert.equal(body.error.code, 'storageUnavailable');
  }
});
