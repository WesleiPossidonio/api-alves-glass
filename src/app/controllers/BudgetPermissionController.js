import service from '../services/BudgetPermissionService.js';
import { budgetHttpError } from './BudgetPdfController.js';
import {
  strictInput,
  uuid,
  budgetError,
} from '../services/BudgetContractService.js';
import { BUDGET_OPERATIONS } from '../services/BudgetAuthorizationService.js';

export class BudgetPermissionController {
  constructor({ service: permissions = service } = {}) {
    this.permissions = permissions;
  }
  actor(request) {
    return { id: request.userId, type: request.actorType };
  }
  async list(request, response) {
    try {
      strictInput(request.query, []);
      return response.json(
        await this.permissions.list(
          uuid(request.params.sectorId),
          this.actor(request),
        ),
      );
    } catch (error) {
      return budgetHttpError(response, error);
    }
  }
  async change(request, response) {
    try {
      strictInput(request.query, []);
      const { sectorId, userId, operation } = request.params;
      uuid(sectorId);
      uuid(userId);
      const isManager = operation === undefined;
      if (!isManager && !BUDGET_OPERATIONS.includes(operation))
        throw budgetError('validation');
      if (!['PUT', 'DELETE'].includes(request.method))
        throw budgetError('validation');
      if (request.method === 'PUT') strictInput(request.body, []);
      else if (request.body && Object.keys(request.body).length)
        throw budgetError('validation');
      const action = isManager
        ? request.method === 'PUT'
          ? 'APPOINT_MANAGER'
          : 'REVOKE_MANAGER'
        : request.method === 'PUT'
          ? 'GRANT'
          : 'REVOKE';
      return response
        .status(200)
        .json(
          await this.permissions.change(
            sectorId,
            userId,
            action,
            isManager ? null : operation,
            this.actor(request),
          ),
        );
    } catch (error) {
      return budgetHttpError(response, error);
    }
  }
}
export default new BudgetPermissionController();
