import { createHmac, timingSafeEqual } from 'node:crypto';

export const SERVICE_ORDER_PROJECTION_COLLECTIONS = Object.freeze({
  orders: 'service_order_read_models_v1',
  movements: 'service_order_movement_read_models_v1',
  processed: 'service_order_processed_events_v1',
});

export class ServiceOrderProjectionService {
  constructor({
    connections,
    pageSize = 100,
    generation = 'generation-0',
    cursorSecret = process.env.SERVICE_ORDER_CURSOR_SECRET,
    canonicalVerifier,
  } = {}) {
    this.connections = connections;
    this.pageSize = pageSize;
    this.generation = generation;
    this.processingGeneration = generation;
    this.cursorSecret = cursorSecret;
    this.canonicalVerifier = canonicalVerifier;
    this.replayInProgress = false;
  }

  async ensureIndexes(db) {
    const { orders, movements, processed } =
      SERVICE_ORDER_PROJECTION_COLLECTIONS;
    await Promise.all([
      db
        .collection(orders)
        .createIndex({ generation: 1, orderId: 1 }, { unique: true }),
      db.collection(orders).createIndex({
        generation: 1,
        clientId: 1,
        createdAt: -1,
        orderId: -1,
      }),
      db
        .collection(orders)
        .createIndex({ generation: 1, sectorId: 1, status: 1, queuedAt: 1 }),
      db.collection(movements).createIndex(
        {
          generation: 1,
          orderId: 1,
          productId: 1,
          aggregateVersion: 1,
          eventId: 1,
        },
        { unique: true },
      ),
      db.collection(movements).createIndex({
        generation: 1,
        orderId: 1,
        productId: 1,
        aggregateVersion: -1,
        eventId: -1,
      }),
      db
        .collection(processed)
        .createIndex({ consumer: 1, eventId: 1 }, { unique: true }),
      db
        .collection(processed)
        .createIndex(
          { aggregateId: 1, generation: 1, aggregateVersion: 1 },
          { unique: true },
        ),
    ]);
  }

  async activateGeneration(db, generation, expectedOrderCount) {
    if (!this.canonicalVerifier)
      throw new Error(
        'Canonical PostgreSQL verifier is required before generation activation',
      );
    if (!Number.isSafeInteger(expectedOrderCount) || expectedOrderCount < 0)
      throw new Error(
        'Expected service order count is required for activation',
      );
    const orders = db.collection(SERVICE_ORDER_PROJECTION_COLLECTIONS.orders);
    await orders.createIndex({ orderId: 1, generation: 1 }, { unique: true });
    const count = await orders.countDocuments({ generation });
    if (count !== expectedOrderCount)
      throw new Error(
        'ServiceOrder rebuild generation count verification failed',
      );
    const projection = await orders
      .find({ generation })
      .project({ orderId: 1, readModelVersion: 1, products: 1 })
      .toArray();
    if (!(await this.canonicalVerifier.verifyGeneration(projection)))
      throw new Error(
        'ServiceOrder rebuild generation canonical verification failed',
      );
    const canonicalVersions = projection.map((entry) =>
      BigInt(entry.readModelVersion),
    );
    if (canonicalVersions.some((version) => version < 0n))
      throw new Error('ServiceOrder rebuild contains an invalid checkpoint');
    const control = db.collection('service_order_projection_control_v1');
    await control.updateOne(
      { _id: 'active' },
      { $set: { generation, orderCount: count, activatedAt: new Date() } },
      { upsert: true },
    );
    this.generation = generation;
    return { generation, orderCount: count };
  }

  async replay(events, { generation, expectedOrderCount } = {}) {
    if (!generation || generation === this.generation || this.replayInProgress)
      throw new Error('Replay requires a new isolated projection generation');
    const priorProcessingGeneration = this.processingGeneration;
    const priorProcessedConsumer = this.processedConsumer;
    this.replayInProgress = true;
    this.processingGeneration = generation;
    const replayConsumer = `service-order-projection-replay:${generation}`;
    let db;
    try {
      db = await this.connections.getMongoDatabase();
      for (const collection of Object.values(
        SERVICE_ORDER_PROJECTION_COLLECTIONS,
      )) {
        const scoped =
          collection === SERVICE_ORDER_PROJECTION_COLLECTIONS.processed
            ? {
                generation,
                consumer: `service-order-projection-replay:${generation}`,
              }
            : { generation };
        const existing = await db.collection(collection).countDocuments(scoped);
        if (existing !== 0)
          throw new Error(
            `Replay generation ${generation} is not empty (${collection})`,
          );
      }
      const ordered = [...events].sort((left, right) => {
        const aggregateOrder = left.aggregateId.localeCompare(
          right.aggregateId,
        );
        if (aggregateOrder !== 0) return aggregateOrder;
        const leftVersion = BigInt(left.aggregateVersion);
        const rightVersion = BigInt(right.aggregateVersion);
        return leftVersion < rightVersion
          ? -1
          : leftVersion > rightVersion
            ? 1
            : 0;
      });
      const lastVersionByAggregate = new Map();
      for (const event of ordered) {
        this.processedConsumer = replayConsumer;
        let result;
        try {
          result = await this.apply(event);
        } finally {
          this.processedConsumer = priorProcessedConsumer;
        }
        if (result.status !== 'APPLIED' && result.status !== 'DUPLICATE')
          throw new Error(
            `Replay failed at event ${event.eventId}: ${result.status}`,
          );
        if (result.status === 'DUPLICATE')
          throw new Error(
            `Replay generation already contains event ${event.eventId}`,
          );
        const previous = lastVersionByAggregate.get(event.aggregateId);
        if (!previous && BigInt(event.aggregateVersion) !== 1n)
          throw new Error(
            `Replay starts after a missing event for ${event.aggregateId}`,
          );
        if (previous && previous + 1n !== BigInt(event.aggregateVersion))
          throw new Error(
            `Replay contains a version gap for ${event.aggregateId}`,
          );
        lastVersionByAggregate.set(
          event.aggregateId,
          BigInt(event.aggregateVersion),
        );
      }
      const result = await this.activateGeneration(
        db,
        generation,
        expectedOrderCount,
      );
      return result;
    } catch (error) {
      if (db)
        for (const collection of Object.values(
          SERVICE_ORDER_PROJECTION_COLLECTIONS,
        )) {
          const scoped =
            collection === SERVICE_ORDER_PROJECTION_COLLECTIONS.processed
              ? {
                  generation,
                  consumer: `service-order-projection-replay:${generation}`,
                }
              : { generation };
          await db.collection(collection).deleteMany(scoped);
        }
      throw error;
    } finally {
      this.processedConsumer = priorProcessedConsumer;
      this.processingGeneration = priorProcessingGeneration;
      this.replayInProgress = false;
    }
  }

  async apply(envelope) {
    const error = this.validate(envelope);
    if (error) return { status: 'INVALID', error };
    if (!this.connections)
      throw new Error('ServiceOrder Mongo connections are required');
    const db = await this.connections.getMongoDatabase();
    await this.ensureIndexes(db);
    const client = await this.connections.getMongoClient();
    const session = client.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await this.applyInTransaction(db, envelope, session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async applyInTransaction(db, event, session) {
    const orders = db.collection(SERVICE_ORDER_PROJECTION_COLLECTIONS.orders);
    const movements = db.collection(
      SERVICE_ORDER_PROJECTION_COLLECTIONS.movements,
    );
    const processed = db.collection(
      SERVICE_ORDER_PROJECTION_COLLECTIONS.processed,
    );
    const already = await processed.findOne(
      {
        consumer: this.processedConsumer ?? 'service-order-projection-v1',
        eventId: event.eventId,
      },
      { session },
    );
    if (already)
      return {
        status: 'DUPLICATE',
        readModelVersion: already.aggregateVersion,
      };
    return await this.applyNextEvent(
      orders,
      movements,
      processed,
      event,
      session,
    );
  }

  async applyNextEvent(orders, movements, processed, event, session) {
    const current = await orders.findOne(
      { orderId: event.aggregateId, generation: this.processingGeneration },
      { session },
    );
    const currentVersion = BigInt(current?.readModelVersion ?? 0);
    const incomingVersion = BigInt(event.aggregateVersion);
    if (incomingVersion <= currentVersion) {
      const duplicateVersion = await processed.findOne(
        {
          aggregateId: event.aggregateId,
          aggregateVersion: incomingVersion.toString(),
          generation: this.processingGeneration,
        },
        { session },
      );
      if (
        duplicateVersion?.eventId === event.eventId &&
        duplicateVersion?.contentHash === this.hashEvent(event)
      )
        return {
          status: 'DUPLICATE',
          readModelVersion: currentVersion.toString(),
        };
      return {
        status: 'CONFLICT',
        readModelVersion: currentVersion.toString(),
      };
    }
    if (incomingVersion !== currentVersion + 1n)
      return {
        status: 'GAP',
        expectedVersion: (currentVersion + 1n).toString(),
      };

    const next = this.reduce(current, event);
    // structuredClone does not preserve BSON ObjectId's prototype.
    // Replacement must retain the original Mongo identity unchanged.
    if (current?._id !== undefined) next._id = current._id;
    const expectedVersion = currentVersion.toString();
    const updateResult = current
      ? await orders.replaceOne(
          {
            orderId: event.aggregateId,
            generation: this.processingGeneration,
            readModelVersion: expectedVersion,
          },
          next,
          { session },
        )
      : await orders.insertOne(next, { session });
    if (
      current &&
      (!updateResult.acknowledged || updateResult.modifiedCount !== 1)
    )
      throw new Error('Concurrent service order projection update');
    if (event.productItemId) {
      await movements.insertOne(
        {
          _id: `${this.processingGeneration}:${event.eventId}`,
          eventId: event.eventId,
          orderId: event.aggregateId,
          productId: event.productItemId,
          aggregateVersion: incomingVersion.toString(),
          eventType: event.eventType,
          occurredAt: new Date(event.occurredAt),
          actor: event.actor ?? null,
          revision: event.revision ?? null,
          cycle: event.cycle ?? null,
          payload: event.payload ?? {},
          generation: this.processingGeneration,
        },
        { session },
      );
    }
    await processed.insertOne(
      {
        _id: `${this.processedConsumer ?? 'service-order-projection-v1'}:${event.eventId}`,
        consumer: this.processedConsumer ?? 'service-order-projection-v1',
        eventId: event.eventId,
        aggregateId: event.aggregateId,
        aggregateVersion: incomingVersion.toString(),
        contentHash: this.hashEvent(event),
        generation: this.processingGeneration,
        processedAt: new Date(),
      },
      { session },
    );
    return { status: 'APPLIED', readModelVersion: incomingVersion.toString() };
  }

  reduce(current, event) {
    const next = current
      ? structuredClone(current)
      : {
          orderId: event.aggregateId,
          sectorId: event.sectorId,
          products: [],
          publicStatus: 'CREATED',
          administrativeState: 'ACTIVE',
          productionCompleted: false,
          createdAt: new Date(event.occurredAt),
          queuedAt: new Date(event.occurredAt),
          generation: this.processingGeneration,
        };
    const payload = event.payload ?? {};
    switch (event.eventType) {
      case 'ServiceOrderRegistered':
        if (
          current &&
          (current.clientId !== undefined ||
            current.externalNumber !== undefined)
        )
          throw new Error(
            'ServiceOrderRegistered event cannot overwrite aggregate identity',
          );
        next.clientId = payload.clientId;
        next.externalNumber = payload.externalNumber;
        next.dueAt = payload.dueAt;
        next.notes = payload.notes ?? null;
        next.status = 'REGISTERED';
        break;
      case 'ServiceOrderFunctionalStatusChanged':
        next.status = payload.status;
        break;
      case 'ServiceOrderPriorityChanged':
        next.priority = payload.priority;
        next.priorityChangedBy = payload.changedBy;
        next.priorityChangedAt = payload.changedAt;
        break;
      case 'ServiceOrderProductCorrected': {
        const product = next.products.find(
          (entry) => entry.itemId === event.productItemId,
        );
        if (product) {
          for (const key of ['name', 'description', 'measurements'])
            if (Object.hasOwn(payload.newValues, key))
              product[key] = structuredClone(payload.newValues[key]);
          product.lastCorrection = {
            correctedBy: payload.correctedBy,
            correctedAt: payload.correctedAt,
          };
        }
        break;
      }
      case 'ServiceOrderAssumed':
        next.responsibleUserId = payload.userId;
        break;
      case 'ServiceOrderResponsibilityReleased':
        if (next.responsibleUserId === payload.userId)
          next.responsibleUserId = null;
        break;
      case 'ServiceOrderProductRegistered': {
        if (event.productItemId !== payload.productId)
          throw new Error('Registered product event identity mismatch');
        const existing = next.products.find(
          (product) => product.itemId === payload.productId,
        );
        if (!existing) {
          next.products.push({
            itemId: payload.productId,
            name: payload.name,
            quantity: payload.quantity,
            completedQuantity: 0,
            blockedQuantity: 0,
            status: 'QUEUED',
            measurements: payload.measurements ?? {},
          });
        }
        break;
      }
      case 'WorkProgressRecorded': {
        const product = next.products.find(
          (item) => item.itemId === event.productItemId,
        );
        if (product) {
          if (
            product.triageStatus === 'ADMIN_TRIAGE_REQUIRED' &&
            !product.triaged
          )
            throw new Error(
              'Work cannot start before required administrative triage',
            );
          // completedQuantity is the product total, not the assignment total.
          product.completedQuantity = payload.completedQuantity;
          product.assignedQuantity = Math.max(
            0,
            Number(product.assignedQuantity ?? 0) -
              Number(payload.quantity ?? 0),
          );
          product.status =
            product.completedQuantity >= product.quantity &&
            Number(product.qualityApprovedQuantity ?? 0) >= product.quantity
              ? 'PRODUCTION_COMPLETED'
              : 'IN_PRODUCTION';
          if (
            product.status === 'IN_PRODUCTION' &&
            next.administrativeState === 'ACTIVE'
          )
            next.publicStatus = 'IN_PRODUCTION';
        }
        break;
      }
      case 'QualityQuantityApproved': {
        const product = next.products.find(
          (item) => item.itemId === event.productItemId,
        );
        if (product) {
          product.qualityApprovedQuantity =
            Number(product.qualityApprovedQuantity ?? 0) +
            Number(payload.quantity ?? 0);
          product.status =
            Number(product.completedQuantity ?? 0) >= product.quantity &&
            product.qualityApprovedQuantity >= product.quantity &&
            !product.qualityPending
              ? 'PRODUCTION_COMPLETED'
              : 'IN_PRODUCTION';
        }
        break;
      }
      case 'QualityInspectionRecorded': {
        next.quality = next.quality ?? [];
        next.quality.push({
          qualityId: payload.qualityId,
          productId: event.productItemId,
          approvedQuantity: payload.approvedQuantity,
          rejectedQuantity: payload.rejectedQuantity,
          reason: payload.reason ?? null,
          status: payload.status,
          occurredAt: event.occurredAt,
        });
        const product = next.products.find(
          (item) => item.itemId === event.productItemId,
        );
        if (product) {
          if (payload.completedQuantity !== undefined)
            product.completedQuantity = payload.completedQuantity;
          if (payload.blockedQuantity !== undefined)
            product.blockedQuantity = payload.blockedQuantity;
          product.qualityPending =
            payload.status === 'OPEN' || payload.status === 'REWORK';
          product.status =
            Number(product.completedQuantity ?? 0) >=
              Number(product.quantity) &&
            product.qualityApprovedQuantity >= Number(product.quantity) &&
            !product.qualityPending
              ? 'PRODUCTION_COMPLETED'
              : 'IN_PRODUCTION';
        }
        break;
      }
      case 'ProductQualityInspectionSignaled':
      case 'ProductReinspectionSignaled':
      case 'QualityInspectionPending': {
        const product = next.products.find(
          (item) => item.itemId === event.productItemId,
        );
        if (product) {
          product.qualityPending = true;
          if (payload.completedQuantity !== undefined)
            product.completedQuantity = payload.completedQuantity;
          if (payload.blockedQuantity !== undefined)
            product.blockedQuantity = payload.blockedQuantity;
          product.status = 'IN_PRODUCTION';
        }
        break;
      }
      case 'ProductNonconformityReported': {
        const product = next.products.find(
          (item) => item.itemId === event.productItemId,
        );
        if (product) {
          product.blockedQuantity += payload.quantity;
          product.status = 'QUALITY_BLOCKED';
        }
        break;
      }
      case 'ServiceOrderCancelled':
        next.status = 'CANCELLED';
        next.administrativeState = 'CANCELLED';
        next.publicStatus = 'CANCELLED';
        break;
      case 'ServiceOrderSuspended':
        next.administrativeState = 'SUSPENDED';
        break;
      case 'ServiceOrderClosed':
        next.administrativeState = 'CLOSED';
        break;
      case 'ServiceOrderProductionClosureConfirmed':
        next.status = 'AWAITING_DELIVERY';
        next.productionCompleted = true;
        next.productionClosure = {
          confirmedBy: payload.confirmedBy,
          confirmedAt: payload.confirmedAt,
        };
        break;
      case 'ServiceOrderCompletionConfirmed':
        next.status = 'COMPLETED';
        next.administrativeState = 'CLOSED';
        next.responsibleUserId = null;
        next.completion = {
          fulfillment: payload.fulfillment,
          confirmedBy: payload.confirmedBy,
          confirmedAt: payload.confirmedAt,
        };
        break;
      case 'ServiceOrderProductionCompleted':
        next.productionCompleted = true;
        break;
      case 'ServiceOrderTriaged':
        for (const triage of payload.products ?? []) {
          const product = next.products.find(
            (item) => item.itemId === triage.productId,
          );
          if (
            product &&
            triage.outcome === 'ADMIN_TRIAGE_REQUIRED' &&
            event.actor?.type !== 'USER'
          )
            throw new Error(
              'Administrative triage requires an authenticated user',
            );
          if (product) {
            product.triageStatus = triage.outcome;
            product.triaged = true;
          }
        }
        break;
      case 'WorkAssigned': {
        const product = next.products.find(
          (item) => item.itemId === event.productItemId,
        );
        if (product) {
          product.assignedQuantity =
            Number(product.assignedQuantity ?? 0) + Number(payload.quantity);
          product.status = 'ASSIGNED';
        }
        break;
      }
      case 'WorkAssignmentReleased': {
        const product = next.products.find(
          (item) => item.itemId === event.productItemId,
        );
        if (product)
          product.assignedQuantity = Math.max(
            0,
            Number(product.assignedQuantity ?? 0) -
              Number(payload.releasedQuantity ?? 0),
          );
        break;
      }
      case 'WorkReassigned': {
        const product = next.products.find(
          (item) => item.itemId === event.productItemId,
        );
        if (product)
          product.assignedQuantity =
            Number(product.assignedQuantity ?? 0) +
            Number(payload.quantity ?? 0);
        break;
      }
      case 'QualityDispositionRecorded':
        next.quality = next.quality ?? [];
        next.quality.push({
          qualityId: payload.qualityId,
          productId: event.productItemId,
          disposition: payload.disposition,
          status: payload.status,
          revision: event.revision,
          cycle: event.cycle,
        });
        break;
      case 'ServiceOrderPublicStatusAdvanced':
        if (next.administrativeState !== 'CANCELLED')
          next.publicStatus = payload.status;
        break;
      case 'SpecificationRevisionRequested': {
        const product = next.products.find(
          (item) => item.itemId === event.productItemId,
        );
        if (product) {
          product.pendingSpecificationRevision = {
            revision: payload.revision,
            measurements: payload.requestedMeasurements,
            reason: payload.reason,
            status: 'PENDING',
          };
        }
        break;
      }
      case 'SpecificationRevisionDecided': {
        const product = next.products.find(
          (item) => item.itemId === event.productItemId,
        );
        if (product) {
          product.pendingSpecificationRevision = null;
          if (payload.status === 'APPROVED') {
            product.specificationRevision = payload.currentRevision;
            product.measurements = payload.measurements ?? product.measurements;
          }
        }
        break;
      }
      case 'ServiceOrderResume':
      case 'ServiceOrderResumed':
        next.administrativeState = 'ACTIVE';
        break;
      case 'ServiceOrderReopen':
      case 'ServiceOrderReopened':
        next.administrativeState = 'ACTIVE';
        next.activeCycle = payload.cycle;
        for (const entry of payload.scope ?? payload.cycle?.scope ?? []) {
          const product = next.products.find(
            (item) => item.itemId === entry.productId,
          );
          if (product)
            product.reopenedScope = {
              cycle: payload.cycle?.number ?? event.cycle,
              quantity: entry.quantity,
            };
        }
        break;
      default:
        next.lastEventType = event.eventType;
    }
    next.priority = next.priority ?? false;
    next.priorityChangedBy = next.priorityChangedBy ?? null;
    next.priorityChangedAt = next.priorityChangedAt ?? null;
    next.readModelVersion = String(event.aggregateVersion);
    next.updatedAt = new Date(event.occurredAt);
    return next;
  }

  validate(event) {
    if (!event || event.aggregateType !== 'SERVICE_ORDER')
      return 'aggregateTypeInvalid';
    for (const field of ['eventId', 'aggregateId', 'sectorId', 'eventType'])
      if (typeof event[field] !== 'string' || !event[field])
        return `${field}Required`;
    if (
      !Number.isSafeInteger(Number(event.schemaVersion)) ||
      Number(event.schemaVersion) !== 1
    )
      return 'schemaVersionUnsupported';
    if (!/^[1-9][0-9]*$/.test(String(event.aggregateVersion)))
      return 'aggregateVersionInvalid';
    if (Number.isNaN(Date.parse(event.occurredAt))) return 'occurredAtInvalid';
    if (
      event.productItemId !== undefined &&
      event.productItemId !== null &&
      typeof event.productItemId !== 'string'
    )
      return 'productItemIdInvalid';
    return null;
  }

  hashEvent(event) {
    return createHmac('sha256', 'service-order-event-integrity-v1')
      .update(JSON.stringify(event))
      .digest('hex');
  }

  cursor({
    orderId,
    productId,
    version,
    generation = this.generation,
    scope,
    lastVersion,
    pageCursor,
    lastKey,
  }) {
    if (!this.cursorSecret)
      throw new Error(
        'SERVICE_ORDER_CURSOR_SECRET is required for paginated reads',
      );
    const payload = Buffer.from(
      JSON.stringify({
        orderId,
        productId,
        version,
        generation,
        scope,
        lastVersion,
        pageCursor,
        lastKey,
      }),
    ).toString('base64url');
    const signature = createHmac('sha256', this.cursorSecret)
      .update(payload)
      .digest('base64url');
    return `${payload}.${signature}`;
  }

  parseCursor(cursor, expected) {
    if (!this.cursorSecret)
      throw new Error(
        'SERVICE_ORDER_CURSOR_SECRET is required for paginated reads',
      );
    let parsed;
    try {
      const [payload, signature, extra] = String(cursor).split('.');
      if (!payload || !signature || extra) throw new Error('format');
      const expectedSignature = createHmac('sha256', this.cursorSecret)
        .update(payload)
        .digest();
      const suppliedSignature = Buffer.from(signature, 'base64url');
      if (
        expectedSignature.length !== suppliedSignature.length ||
        !timingSafeEqual(expectedSignature, suppliedSignature)
      )
        throw new Error('signature');
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      const error = new Error('Invalid service order movement cursor');
      error.code = 'CURSOR_INVALID';
      throw error;
    }
    for (const key of ['orderId', 'productId', 'generation', 'scope']) {
      if (expected[key] !== undefined && parsed[key] !== expected[key]) {
        const error = new Error('Service order movement cursor scope mismatch');
        error.code = 'CURSOR_SCOPE_MISMATCH';
        throw error;
      }
    }
    return parsed;
  }
}

export default ServiceOrderProjectionService;
