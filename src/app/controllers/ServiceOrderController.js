import {
  serviceOrderService,
  ServiceOrderApplicationError,
} from '../services/ServiceOrderService.js';
import { validateServiceOrderRegistration } from '../services/serviceOrderDomain.js';
import ServiceOrderReadService, {
  ServiceOrderReadError,
} from '../services/ServiceOrderReadService.js';

const readService = new ServiceOrderReadService();

const actorFrom = (request) => ({
  id: request.userId,
  type: request.actorType,
  role: request.userRole,
});

const sendError = (response, error) => {
  if (error instanceof ServiceOrderApplicationError) {
    return response.status(error.status).json({ error: error.code });
  }
  if (error instanceof ServiceOrderReadError) {
    return response.status(error.status).json({ error: error.code });
  }
  if (error?.code === 'SERVICE_ORDER_FORBIDDEN') {
    return response.status(403).json({ error: 'forbidden' });
  }
  if (error?.name === 'ServiceOrderDomainError') {
    return response.status(422).json({ error: error.code });
  }
  throw error;
};

class ServiceOrderController {
  async create(request, response, next) {
    try {
      validateServiceOrderRegistration(request.body);
      const order = await serviceOrderService.register(
        request.body,
        actorFrom(request),
      );
      return response.status(201).json({ data: order });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async show(request, response, next) {
    try {
      const order = await readService.getOrder({
        orderId: request.params.id,
        actor: actorFrom(request),
      });
      return response.json({ data: order });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async queue(request, response, next) {
    try {
      const data = await serviceOrderService.getQueue(
        request.params.sectorId,
        actorFrom(request),
        { limit: request.query.limit, cursor: request.query.cursor },
      );
      return response.json({ data });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async assign(request, response, next) {
    try {
      const assignment = await serviceOrderService.assign(
        { orderId: request.params.id, ...request.body },
        actorFrom(request),
      );
      return response.status(201).json({ data: assignment });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async assume(request, response, next) {
    try {
      const result = await serviceOrderService.assumeByExternalNumber(
        request.body,
        actorFrom(request),
      );
      return response.status(201).json({ data: result });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async releaseResponsibility(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.releaseResponsibility(
        request.params.id,
        request.body,
        actorFrom(request),
      ),
    );
  }

  async transitionStatus(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.transitionFunctionalStatus(
        request.params.id,
        request.body.status,
        actorFrom(request),
      ),
    );
  }

  async releaseAssignment(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.releaseAssignment(
        request.params.assignmentId,
        actorFrom(request),
      ),
    );
  }

  async reassign(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.reassign(
        { assignmentId: request.params.assignmentId, ...request.body },
        actorFrom(request),
      ),
    );
  }

  async execute(request, response, next) {
    try {
      const result = await serviceOrderService.recordExecution(
        { assignmentId: request.params.assignmentId, ...request.body },
        actorFrom(request),
      );
      return response.status(201).json({ data: result });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async triage(request, response, next) {
    try {
      const data = await serviceOrderService.triage(
        request.params.id,
        actorFrom(request),
      );
      return response.json({ data });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async advanceStatus(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.advancePublicStatus(
        request.params.id,
        request.body.status,
        actorFrom(request),
      ),
    );
  }

  async suspend(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.suspend(
        request.params.id,
        request.body,
        actorFrom(request),
      ),
    );
  }

  async close(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.close(request.params.id, actorFrom(request)),
    );
  }

  async requestRevision(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.requestSpecificationRevision(
        request.params.id,
        request.body,
        actorFrom(request),
      ),
    );
  }

  async decideRevision(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.decideSpecificationRevision(
        request.params.id,
        request.body,
        actorFrom(request),
      ),
    );
  }

  async reportQuality(request, response, next) {
    return this.signalProductForInspection(request, response, next);
  }

  async pendingQuality(request, response, next) {
    try {
      const data = await serviceOrderService.getPendingQualityInspections(
        request.params.sectorId,
        request.query.externalNumber,
        actorFrom(request),
      );
      return response.json({ data });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async qualityQueue(request, response, next) {
    try {
      const data = await serviceOrderService.getQualityQueue(
        request.params.sectorId,
        actorFrom(request),
        request.query.externalNumber,
      );
      return response.json({ data });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async signalProductForInspection(request, response, next) {
    try {
      const data = await serviceOrderService.signalProductForInspection(
        { orderId: request.params.id, ...request.body },
        actorFrom(request),
      );
      return response.status(201).json({ data });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async decideQuality(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.decideQuality(
        { qualityId: request.params.qualityId, ...request.body },
        actorFrom(request),
      ),
    );
  }

  async inspectQuality(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.inspectQuality(
        { qualityId: request.params.qualityId, ...request.body },
        actorFrom(request),
      ),
    );
  }

  async resume(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.resume(request.params.id, actorFrom(request)),
    );
  }

  async closeProduction(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.closeProduction(
        request.params.id,
        request.body,
        actorFrom(request),
      ),
    );
  }

  async setPriority(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.setPriority(
        request.params.id,
        request.body,
        actorFrom(request),
      ),
    );
  }

  async correctProduct(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.correctProduct(
        request.params.id,
        request.params.productId,
        request.body,
        actorFrom(request),
      ),
    );
  }

  async complete(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.complete(
        request.params.id,
        request.body,
        actorFrom(request),
      ),
    );
  }

  async cancel(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.cancel(
        request.params.id,
        request.body,
        actorFrom(request),
      ),
    );
  }

  async reopen(request, response, next) {
    return this.adminMutation(request, response, next, () =>
      serviceOrderService.reopen(
        request.params.id,
        request.body,
        actorFrom(request),
      ),
    );
  }

  async clientOrders(request, response, next) {
    try {
      const data = await readService.getClientOrders({
        clientId: request.userId,
        actor: actorFrom(request),
        limit: request.query.limit,
        cursor: request.query.cursor,
      });
      return response.json({ data });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async clientOrder(request, response, next) {
    try {
      const data = await readService.getOrder({
        orderId: request.params.id,
        actor: actorFrom(request),
        client: true,
        productId: request.query.productId,
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
      return response.json({ data });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async configurePermission(request, response, next) {
    try {
      const data = await serviceOrderService.configurePermission(
        request.body,
        actorFrom(request),
      );
      return response.status(201).json({ data });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async revokePermission(request, response, next) {
    try {
      const data = await serviceOrderService.revokePermission(
        request.params.grantId,
        request.body,
        actorFrom(request),
      );
      return response.json({ data });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }

  async adminMutation(request, response, next, operation) {
    try {
      const data = await operation();
      return response.json({ data });
    } catch (error) {
      try {
        return sendError(response, error);
      } catch (unhandled) {
        return next(unhandled);
      }
    }
  }
}

export default new ServiceOrderController();
