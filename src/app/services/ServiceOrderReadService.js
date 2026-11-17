import ServiceOrderRepository from '../repositories/ServiceOrderRepository.js';
import ServiceOrderPermissionRepository from '../repositories/ServiceOrderPermissionRepository.js';
import ServiceOrderProjectionService, {
  SERVICE_ORDER_PROJECTION_COLLECTIONS,
} from './ServiceOrderProjectionService.js';
import { createCqrsConnections } from '../../config/cqrs.js';
import Database from '../../database/index.js';

class ServiceOrderReadError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export class ServiceOrderReadService {
  constructor({
    database = Database,
    orders = ServiceOrderRepository,
    permissions = ServiceOrderPermissionRepository,
    connections = createCqrsConnections(),
    projection,
  } = {}) {
    this.database = database;
    this.orders = orders;
    this.permissions = permissions;
    this.connections = connections;
    this.projection =
      projection ?? new ServiceOrderProjectionService({ connections });
  }

  async getOrder({
    orderId,
    actor,
    client = false,
    productId,
    cursor,
    limit = 50,
  }) {
    // Client callers must never traverse the internal RF-32 history DTO.
    if (client) return this.getClientOrder({ orderId, actor });
    if (!actor?.id)
      throw new ServiceOrderReadError('authenticatedActorRequired', 401);
    let ownerId;
    if (client) ownerId = actor.id;
    else {
      if (actor.type !== 'user')
        throw new ServiceOrderReadError('userRequired', 403);
      const canonical = await this.orders.findById(orderId);
      if (!canonical)
        throw new ServiceOrderReadError('serviceOrderNotFound', 404);
      if (actor.role !== 'admin') {
        const sectorGrant = await this.orders.hasUserSectorGrant(
          actor.id,
          canonical.sector_id,
        );
        if (!sectorGrant)
          throw new ServiceOrderReadError('sectorGrantRequired', 403);
      }
      if (actor.role !== 'admin')
        await this.permissions.assertPermission(
          actor.id,
          canonical.sector_id,
          'READ_INTERNAL',
        );
    }

    const db = await this.connections.getMongoDatabase();
    const control = await db
      .collection('service_order_projection_control_v1')
      .findOne({ _id: 'active' });
    const generation =
      control?.generation ??
      (client ? 'generation-0' : this.projection.generation);
    const filter = {
      orderId,
      generation,
      ...(ownerId ? { clientId: ownerId } : {}),
    };
    const projected = await db
      .collection(SERVICE_ORDER_PROJECTION_COLLECTIONS.orders)
      .findOne(filter);
    if (!projected)
      throw new ServiceOrderReadError(
        client ? 'serviceOrderNotFound' : 'projectionPending',
        client ? 404 : 503,
      );
    const canonical = await this.orders.findById(orderId);
    if (!canonical || (ownerId && canonical.client_id !== ownerId))
      throw new ServiceOrderReadError('serviceOrderNotFound', 404);
    if (!client && canonical.sector_id !== projected.sectorId)
      throw new ServiceOrderReadError('projectionSectorMismatch', 409);
    if (
      BigInt(projected.readModelVersion) > BigInt(canonical.operational_version)
    )
      throw new ServiceOrderReadError('projectionAheadOfCanonical', 409);
    if (
      productId &&
      !(projected.products ?? []).some(
        (product) => product.itemId === productId,
      )
    )
      throw new ServiceOrderReadError('productNotFound', 404);
    if (
      !client &&
      !['ACTIVE', 'SUSPENDED', 'CLOSED', 'CANCELLED'].includes(
        projected.administrativeState,
      )
    )
      throw new ServiceOrderReadError('projectionStateInvalid', 409);

    const pageLimit = Math.min(
      Math.max(Number.parseInt(limit, 10) || 50, 1),
      100,
    );
    let cursorState = null;
    if (cursor) {
      try {
        cursorState = this.projection.parseCursor(cursor, {
          orderId,
          generation,
          scope: actor.id,
        });
        if (
          !/^\d+$/.test(cursorState.version) ||
          !/^[1-9]\d*$/.test(cursorState.lastKey?.aggregateVersion) ||
          typeof cursorState.lastKey?.eventId !== 'string'
        )
          throw new Error('Invalid movement cursor');
      } catch {
        throw new ServiceOrderReadError('cursorInvalid', 400);
      }
    }
    if (cursorState && productId && cursorState.productId !== productId) {
      throw new ServiceOrderReadError('cursorProductMismatch', 400);
    }
    if (cursorState && !productId) productId = cursorState.productId;
    if (
      productId &&
      !(projected.products ?? []).some(
        (product) => product.itemId === productId,
      )
    )
      throw new ServiceOrderReadError('productNotFound', 404);
    if (
      cursorState &&
      cursorState.productId === null &&
      cursorState.lastKey?.createdAt
    )
      throw new ServiceOrderReadError('cursorScopeInvalid', 400);
    if (
      cursorState &&
      BigInt(projected.readModelVersion) < BigInt(cursorState.version)
    )
      throw new ServiceOrderReadError('projectionBehindCursor', 409);
    const targetVersion = cursorState?.version ?? projected.readModelVersion;
    const lastKey = cursorState?.lastKey ?? null;
    const movementFilter = {
      orderId,
      generation,
      aggregateVersion: { $lte: targetVersion },
      productId: productId ?? { $type: 'string' },
      ...(lastKey
        ? {
            $or: [
              {
                aggregateVersion: String(lastKey.aggregateVersion),
                eventId: { $lt: lastKey.eventId },
              },
              { aggregateVersion: { $lt: String(lastKey.aggregateVersion) } },
            ],
          }
        : {}),
    };
    const movementRows = await db
      .collection(SERVICE_ORDER_PROJECTION_COLLECTIONS.movements)
      .find(movementFilter)
      .collation({ locale: 'en', numericOrdering: true })
      .sort({ aggregateVersion: -1, eventId: -1 })
      .limit(pageLimit + 1)
      .toArray();
    if (
      cursorState &&
      movementRows.length === 0 &&
      BigInt(cursorState.version) > BigInt(projected.readModelVersion)
    )
      throw new ServiceOrderReadError('projectionBehindCursor', 409);
    const hasMore = movementRows.length > pageLimit;
    const page = movementRows.slice(0, pageLimit);
    const byProduct = new Map();
    for (const movement of page) {
      const bucket = byProduct.get(movement.productId) ?? [];
      bucket.push(this.toMovement(movement));
      byProduct.set(movement.productId, bucket);
    }
    const products = (projected.products ?? [])
      .filter((product) => !productId || product.itemId === productId)
      .map((product) => ({
        ...product,
        movements: byProduct.get(product.itemId) ?? [],
      }));
    const last = page.at(-1);
    const nextCursor =
      hasMore && last
        ? this.projection.cursor({
            orderId,
            productId: productId ?? null,
            version: targetVersion,
            lastKey: {
              aggregateVersion: last.aggregateVersion,
              eventId: last.eventId,
            },
            generation,
            scope: actor.id,
          })
        : null;
    return {
      order: {
        id: projected.orderId,
        externalNumber: projected.externalNumber,
        clientId: client ? undefined : projected.clientId,
        sectorId: projected.sectorId,
        status: client
          ? this.publicStatus(projected)
          : (projected.status ?? projected.publicStatus),
        productionCompleted: projected.productionCompleted,
        products,
        ...(!client
          ? {
              priority: projected.priority ?? false,
              priorityChangedBy: projected.priorityChangedBy ?? null,
              priorityChangedAt: projected.priorityChangedAt ?? null,
            }
          : {}),
        movementsNextCursor: nextCursor,
      },
      operationalVersion: String(canonical.operational_version),
      readModelVersion: String(projected.readModelVersion),
      readModelGeneration: generation,
      consistency: 'EVENTUAL',
    };
  }

  async getClientOrders({ clientId, actor, limit = 50, cursor }) {
    if (!actor?.id || actor.type !== 'client' || actor.id !== clientId)
      throw new ServiceOrderReadError('clientOwnershipRequired', 403);
    const pageLimit = Math.min(
      Math.max(Number.parseInt(limit, 10) || 50, 1),
      100,
    );
    const projection = this.projection;
    if (!projection.cursorSecret)
      throw new ServiceOrderReadError('cursorUnavailable', 503);
    let page = null;
    if (cursor) {
      try {
        page = projection.parseCursor(cursor, {
          orderId: 'CLIENT_ORDERS',
          scope: clientId,
        });
        if (
          !page.pageCursor?.createdAt ||
          Number.isNaN(Date.parse(page.pageCursor.createdAt)) ||
          typeof page.pageCursor.id !== 'string' ||
          !page.pageCursor.id
        )
          throw new Error('Invalid client cursor');
      } catch {
        throw new ServiceOrderReadError('cursorInvalid', 400);
      }
    }
    if (page?.pageCursor?.createdAt && page?.pageCursor?.id) {
      page.createdAt = page.pageCursor.createdAt;
      page.id = page.pageCursor.id;
    }
    const orders = await this.orders.findForClient(clientId, {
      limit: pageLimit + 1,
      afterCreatedAt: page?.createdAt,
      afterId: page?.id,
    });
    const hasMore = orders.length > pageLimit;
    const selected = orders.slice(0, pageLimit);
    const last = selected.at(-1);
    const canonicalRows = await Promise.all(
      selected.map((order) => this.orders.findById(order.id)),
    );
    if (canonicalRows.some((order) => !order || order.client_id !== clientId))
      throw new ServiceOrderReadError('clientOwnershipRequired', 403);
    // Check canonical state before Mongo: stale projections must not expose a
    // previous authorized milestone after cancellation/completion.
    for (const order of canonicalRows)
      this.clientMilestone(order.functional_status);
    if (!selected.length) return { serviceOrders: [], nextCursor: null };
    const db = await this.connections.getMongoDatabase();
    const orderIds = selected.map((order) => order.id);
    const control = await db
      .collection('service_order_projection_control_v1')
      .findOne({ _id: 'active' });
    const generation = control?.generation ?? 'generation-0';
    if (page && page.generation !== generation)
      throw new ServiceOrderReadError('cursorInvalid', 400);
    const projections = await db
      .collection(SERVICE_ORDER_PROJECTION_COLLECTIONS.orders)
      .find({ orderId: { $in: orderIds }, generation, clientId })
      .toArray();
    const projectionById = new Map(
      projections.map((item) => [item.orderId, item]),
    );
    const data = [];
    for (const order of canonicalRows) {
      const projected = projectionById.get(order.id);
      if (!projected) throw new ServiceOrderReadError('projectionPending', 503);
      data.push(this.clientOrderDto(order, projected));
    }
    return {
      serviceOrders: data,
      nextCursor:
        hasMore && last
          ? projection.cursor({
              orderId: 'CLIENT_ORDERS',
              version: '0',
              generation,
              scope: clientId,
              pageCursor: {
                createdAt: last.created_at ?? last.createdAt,
                id: last.id,
              },
            })
          : null,
    };
  }

  async getClientOrder({ orderId, actor }) {
    if (!actor?.id || actor.type !== 'client')
      throw new ServiceOrderReadError('clientOwnershipRequired', 403);
    const canonical = await this.orders.findById(orderId);
    if (!canonical || canonical.client_id !== actor.id)
      throw new ServiceOrderReadError('serviceOrderNotFound', 404);
    this.clientMilestone(canonical.functional_status);
    const db = await this.connections.getMongoDatabase();
    const control = await db
      .collection('service_order_projection_control_v1')
      .findOne({ _id: 'active' });
    const projected = await db
      .collection(SERVICE_ORDER_PROJECTION_COLLECTIONS.orders)
      .findOne({
        orderId,
        clientId: actor.id,
        generation: control?.generation ?? 'generation-0',
      });
    if (!projected) throw new ServiceOrderReadError('projectionPending', 503);
    return this.clientOrderDto(canonical, projected);
  }

  clientMilestone(status) {
    const milestones = {
      REGISTERED: 'Pedido cadastrado',
      AWAITING_SUPPLIER: 'Aguardando fornecedor',
      IN_PRODUCTION: 'Em produção',
      AWAITING_DELIVERY: 'Aguardando entrega/instalação',
      COMPLETED: 'Concluído',
      CANCELLED: 'Cancelado',
    };
    if (!Object.hasOwn(milestones, status))
      throw new ServiceOrderReadError('clientStatusMappingPending', 409);
    return milestones[status];
  }

  clientOrderDto(canonical, projected) {
    if (
      projected.orderId !== canonical.id ||
      projected.clientId !== canonical.client_id ||
      projected.sectorId !== canonical.sector_id
    )
      throw new ServiceOrderReadError('projectionIdentityMismatch', 409);
    // Fail closed on lag rather than show an obsolete milestone. No internal
    // version, person, product or quality field crosses this allowlist.
    if (
      String(projected.readModelVersion) !==
        String(canonical.operational_version) ||
      projected.status !== canonical.functional_status
    )
      throw new ServiceOrderReadError('projectionPending', 503);
    return {
      order: {
        id: canonical.id,
        externalNumber: canonical.external_number,
        status: this.clientMilestone(projected.status),
      },
    };
  }

  toMovement(row) {
    return {
      ...structuredClone(row.payload ?? {}),
      eventId: row.eventId,
      type: row.eventType,
      aggregateVersion: row.aggregateVersion,
      occurredAt: row.occurredAt,
      quantity: row.payload?.quantity ?? row.payload?.completedQuantity ?? null,
      ...(row.actor?.id ? { performedBy: row.actor.id } : {}),
      revision: row.revision,
      cycle: row.cycle,
    };
  }

  publicStatus(projected) {
    if (projected.administrativeState === 'CANCELLED') return 'CANCELLED';
    return [
      'CREATED',
      'APPROVED',
      'MATERIALS_SEPARATED',
      'IN_PRODUCTION',
      'IN_ROUTE',
      'DELIVERED',
      'CANCELLED',
    ].includes(projected.publicStatus)
      ? projected.publicStatus
      : 'CREATED';
  }
}

export default ServiceOrderReadService;
export { ServiceOrderReadError };
