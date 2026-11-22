import { ClientBudgetPdfService } from '../services/ClientBudgetPdfService.js';
import streamService from '../services/BudgetPdfStreamService.js';
import { strictInput } from '../services/BudgetContractService.js';
import { budgetHttpError, streamBudgetHttp } from './BudgetPdfController.js';

export class ClientBudgetPdfController {
  constructor({ read, stream = streamService, env = process.env } = {}) {
    this.read =
      read ??
      new ClientBudgetPdfService({ cursorSecret: env.BUDGETS_CURSOR_SECRET });
    this.stream = stream;
  }
  actor(request) {
    return { id: request.userId, type: request.actorType };
  }
  async index(request, response) {
    try {
      if (
        !this.read.cursors &&
        (typeof this.read.cursorSecret !== 'string' ||
          Buffer.byteLength(this.read.cursorSecret) < 32)
      )
        return budgetHttpError(response, { code: 'storageUnavailable' });
      return response.json(
        await this.read.list(request.query, this.actor(request)),
      );
    } catch (error) {
      return budgetHttpError(response, error);
    }
  }
  async show(request, response) {
    try {
      strictInput(request.query, []);
      return response.json(
        await this.read.detail(request.params.id, this.actor(request)),
      );
    } catch (error) {
      return budgetHttpError(response, error);
    }
  }
  async pdf(request, response) {
    return streamBudgetHttp(
      this.stream,
      request,
      response,
      this.actor(request),
      true,
    );
  }
}
export default new ClientBudgetPdfController();
