import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Database from '../../../src/database/index.js';
import Orders from '../../../src/app/repositories/ServiceOrderRepository.js';
import Events from '../../../src/app/repositories/ServiceOrderEventRepository.js';
import ReadService from '../../../src/app/services/ServiceOrderReadService.js';
import Projection, {
  SERVICE_ORDER_PROJECTION_COLLECTIONS as collections,
} from '../../../src/app/services/ServiceOrderProjectionService.js';
import { ServiceOrderProjectionConsumer } from '../../../src/app/services/ServiceOrderProjectionConsumer.js';
import { ServiceOrderOutboxPublisher } from '../../../src/app/services/ServiceOrderOutboxPublisher.js';
import { createCqrsConnections } from '../../../src/config/cqrs.js';
import { createRecoveryIdentityFixture } from './recovery-identity-fixture.js';

test(
  'RF32 real PostgreSQL Outbox / RabbitMQ / Mongo: product history, numeric pagination, replay and isolation',
  {
    skip: process.env.RUN_POSTGRES_SERVICE_ORDER_RECOVERY_INTEGRATION !== '1',
  },
  async () => {
    assert.equal(process.env.DB_HOST, 'feature004-recovery-20261113-postgres');
    assert.equal(process.env.DB_DATABASE, 'feature004_recovery_integration');
    assert.equal(process.env.DB_USERNAME, 'feature004_recovery_dev');
    assert.equal(
      process.env.MONGODB_URI,
      'mongodb://feature004-recovery-20261113-mongodb:27017/?replicaSet=feature004-recovery-rs',
    );
    assert.equal(
      process.env.MONGODB_DATABASE,
      'feature004_recovery_integration',
    );
    assert.equal(
      new URL(process.env.RABBITMQ_URL).hostname,
      'feature004-recovery-20261113-rabbitmq',
    );
    const connections = createCqrsConnections();
    const key = randomUUID();
    const generation = `rf32-${key}`;
    const projection = new Projection({
      connections,
      generation,
      cursorSecret: 'rf32-recovery-cursor-secret',
    });
    const rollback = new Error('RF32 rollback-only PostgreSQL fixture');
    let channel;
    let orderId;
    const sql = async (query, bind = [], transaction) =>
      (await Database.connection.query(query, { bind, transaction }))[0];
    const snapshot = async () => {
      const result = {};
      for (const table of [
        'service_orders',
        'service_order_products',
        'service_order_events',
        'service_order_outbox',
        'service_order_qualities',
      ])
        result[table] = await sql(
          `SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`,
        );
      return result;
    };
    try {
      const db = await connections.getMongoDatabase();
      const hello = await (await connections.getMongoClient())
        .db('admin')
        .command({ hello: 1 });
      assert.equal(hello.setName, 'feature004-recovery-rs');
      assert.equal(hello.isWritablePrimary, true);
      const control = await db
        .collection('service_order_projection_control_v1')
        .findOne({ _id: 'active' });
      const mongoBefore = {};
      for (const name of Object.values(collections))
        mongoBefore[name] = await db.collection(name).find({}).toArray();
      const before = await snapshot();
      const [identity] = await sql(
        'SELECT current_database() db,current_user usr',
      );
      assert.deepEqual(identity, {
        db: 'feature004_recovery_integration',
        usr: 'feature004_recovery_dev',
      });
      // The identity fixture and canonical OS are rolled back with this transaction.
      await assert.rejects(
        Database.connection.transaction(async (transaction) => {
          const { reference } = await createRecoveryIdentityFixture(
            sql,
            transaction,
          );
          assert.ok(reference);
          const order = await Orders.create(
            {
              sectorId: reference.sector_id,
              clientId: reference.client_id,
              createdBy: reference.created_by,
              externalNumber: `RF32-${key}`,
              dueAt: '2026-12-01',
            },
            {
              transaction,
              products: [
                {
                  name: 'RF32 A',
                  quantity: 2,
                  measurements: { width: '100', height: '200' },
                },
                {
                  name: 'RF32 B',
                  quantity: 1,
                  measurements: { widthMm: '80', heightMm: '90' },
                },
              ],
            },
          );
          orderId = order.id;
          const a = order.products.find((product) => product.name === 'RF32 A');
          const b = order.products.find((product) => product.name === 'RF32 B');
          const append = (eventType, payload, productItemId) =>
            Events.append(
              {
                aggregateId: order.id,
                sectorId: order.sector_id,
                actorUserId: reference.created_by,
                eventType,
                payload,
                productItemId,
              },
              { transaction },
            );
          // Existing canonical event types; fixture facts only, not new domain commands or physical event types.
          await append('ServiceOrderRegistered', {
            clientId: reference.client_id,
            externalNumber: order.external_number,
          });
          for (const product of order.products)
            await append(
              'ServiceOrderProductRegistered',
              {
                productId: product.id,
                name: product.name,
                quantity: product.quantity,
                measurements: product.measurements,
              },
              product.id,
            );
          await append('ServiceOrderFunctionalStatusChanged', {
            status: 'AWAITING_SUPPLIER',
          });
          await append('ServiceOrderFunctionalStatusChanged', {
            status: 'IN_PRODUCTION',
          });
          await append(
            'ServiceOrderProductCorrected',
            {
              productId: a.id,
              previousValues: { measurements: a.measurements },
              newValues: { measurements: { width: '101', height: '200' } },
              correctedBy: reference.created_by,
              correctedAt: new Date().toISOString(),
            },
            a.id,
          );
          await append(
            'ProductQualityInspectionSignaled',
            { quantity: 2, completedQuantity: 2, blockedQuantity: 0 },
            a.id,
          );
          await append(
            'QualityInspectionRecorded',
            {
              approvedQuantity: 1,
              rejectedQuantity: 1,
              reason: 'Edge damaged',
              status: 'REJECTED',
              completedQuantity: 1,
              blockedQuantity: 1,
            },
            a.id,
          );
          await append('QualityQuantityApproved', { quantity: 1 }, a.id);
          await append(
            'ProductReinspectionSignaled',
            { quantity: 1, completedQuantity: 2, blockedQuantity: 0 },
            a.id,
          );
          await append(
            'QualityInspectionRecorded',
            {
              approvedQuantity: 1,
              rejectedQuantity: 0,
              status: 'APPROVED',
              completedQuantity: 2,
              blockedQuantity: 0,
            },
            a.id,
          );
          await append('QualityQuantityApproved', { quantity: 1 }, a.id);
          await append(
            'ProductQualityInspectionSignaled',
            { quantity: 1, completedQuantity: 1, blockedQuantity: 0 },
            b.id,
          );
          await append(
            'QualityInspectionRecorded',
            {
              approvedQuantity: 1,
              rejectedQuantity: 0,
              status: 'APPROVED',
              completedQuantity: 1,
              blockedQuantity: 0,
            },
            b.id,
          );
          await append('QualityQuantityApproved', { quantity: 1 }, b.id);
          await append('ServiceOrderPriorityChanged', {
            priority: true,
            changedBy: reference.created_by,
            changedAt: new Date().toISOString(),
          });
          await append('ServiceOrderProductionClosureConfirmed', {
            confirmedBy: reference.created_by,
            confirmedAt: new Date().toISOString(),
          });
          await append('ServiceOrderCompletionConfirmed', {
            fulfillment: 'DELIVERY',
            confirmedBy: reference.created_by,
            confirmedAt: new Date().toISOString(),
          });
          const outbox = await sql(
            'SELECT * FROM service_order_outbox WHERE aggregate_id=$1 ORDER BY aggregate_version',
            [order.id],
            transaction,
          );
          const canonicalEvents = await sql(
            'SELECT * FROM service_order_events WHERE aggregate_id=$1 ORDER BY aggregate_version',
            [order.id],
            transaction,
          );
          assert.equal(outbox.length, 18);
          assert.equal(canonicalEvents.length, 18);
          const envelopes = outbox.map((row) => row.payload);
          const rabbit = await connections.getRabbitConnection();
          channel = await rabbit.createConfirmChannel();
          const queue = await channel.assertQueue('', {
            exclusive: true,
            autoDelete: true,
          });
          // Route to this exclusive test queue; never start the shared recovery consumer or drain its queues.
          const publisher = new ServiceOrderOutboxPublisher({ connections });
          publisher.claim = async () => outbox;
          publisher.openConfirmChannel = async () => ({
            on: (event, listener) => channel.on(event, listener),
            removeListener: (event, listener) =>
              channel.removeListener(event, listener),
            publish: (_exchange, _route, body, options, callback) =>
              channel.sendToQueue(queue.queue, body, options, callback),
            close: async () => {},
          });
          publisher.markPublished = async (eventId) =>
            sql(
              "UPDATE service_order_outbox SET status='PUBLISHED' WHERE event_id=$1",
              [eventId],
              transaction,
            );
          assert.deepEqual(await publisher.publishBatch(), {
            claimed: 18,
            published: 18,
          });
          const consumer = new ServiceOrderProjectionConsumer({
            connections,
            projection,
          });
          for (let index = 0; index < envelopes.length; index++) {
            const message = await channel.get(queue.queue, { noAck: false });
            assert.ok(message);
            const applied = await consumer.handle(channel, message);
            assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
          }
          assert.equal(
            (await projection.apply(envelopes[7])).status,
            'DUPLICATE',
          );
          assert.equal(
            await db
              .collection(collections.movements)
              .countDocuments({ generation, orderId: order.id }),
            12,
          );
          const readConnections = {
            getMongoDatabase: async () => ({
              collection: (name) =>
                name === 'service_order_projection_control_v1'
                  ? { findOne: async () => ({ generation }) }
                  : db.collection(name),
            }),
          };
          const read = new ReadService({
            projection,
            connections: readConnections,
            orders: {
              findById: (id) => Orders.findById(id, { transaction }),
              hasUserSectorGrant: async () => true,
            },
            permissions: { assertPermission: async () => {} },
          });
          const actor = {
            id: reference.created_by,
            type: 'user',
            role: 'admin',
          };
          const all = [];
          let cursor;
          let previousPageMinimum;
          do {
            const result = await read.getOrder({
              orderId: order.id,
              actor,
              cursor,
              limit: 2,
            });
            assert.equal(result.order.priority, true);
            assert.equal(result.order.status, 'COMPLETED');
            assert.equal(result.readModelVersion, '18');
            const pageVersions = result.order.products.flatMap((product) =>
              product.movements.map((movement) =>
                BigInt(movement.aggregateVersion),
              ),
            );
            if (previousPageMinimum !== undefined)
              assert.ok(
                pageVersions.every((version) => version < previousPageMinimum),
              );
            previousPageMinimum = pageVersions.reduce(
              (minimum, version) => (version < minimum ? version : minimum),
              19n,
            );
            for (const product of result.order.products) {
              assert.equal(product.status, 'PRODUCTION_COMPLETED');
              const versions = product.movements.map((movement) =>
                BigInt(movement.aggregateVersion),
              );
              assert.ok(
                versions.every(
                  (version, index) =>
                    index === 0 || version < versions[index - 1],
                ),
              );
              for (const movement of product.movements) {
                assert.equal(
                  canonicalEvents.find(
                    (event) => event.event_id === movement.eventId,
                  ).product_item_id,
                  product.itemId,
                );
                assert.equal(movement.performedBy, reference.created_by);
                assert.ok(movement.occurredAt);
                all.push(movement);
              }
            }
            cursor = result.order.movementsNextCursor;
          } while (cursor);
          assert.deepEqual(
            all
              .map((row) => row.aggregateVersion)
              .sort((left, right) => Number(right) - Number(left)),
            ['15', '14', '13', '12', '11', '10', '9', '8', '7', '6', '3', '2'],
          );
          const correction = all.find(
            (row) => row.type === 'ServiceOrderProductCorrected',
          );
          assert.equal(correction.previousValues.measurements.width, '100');
          assert.equal(correction.newValues.measurements.width, '101');
          assert.equal(
            all.find((row) => row.rejectedQuantity === 1).reason,
            'Edge damaged',
          );
          const first = await read.getOrder({
            orderId: order.id,
            actor,
            productId: a.id,
            limit: 1,
          });
          await assert.rejects(
            read.getOrder({
              orderId: order.id,
              actor,
              productId: b.id,
              cursor: first.order.movementsNextCursor,
            }),
            { code: 'cursorProductMismatch' },
          );
          await assert.rejects(
            read.getOrder({
              orderId: order.id,
              actor: { ...actor, id: randomUUID() },
              cursor: first.order.movementsNextCursor,
            }),
            { code: 'cursorInvalid' },
          );
          await assert.rejects(
            read.getOrder({
              orderId: order.id,
              actor,
              cursor: first.order.movementsNextCursor + 'x',
            }),
            { code: 'cursorInvalid' },
          );
          read.orders.hasUserSectorGrant = async () => false;
          await assert.rejects(
            read.getOrder({
              orderId: order.id,
              actor: { ...actor, role: 'user' },
            }),
            { code: 'sectorGrantRequired' },
          );
          // Replay in a new isolated generation without activation or any deletion.
          const rebuilt = new Projection({
            connections,
            generation,
          });
          rebuilt.activateGeneration = async (_db, target, count) => {
            assert.equal(count, 1);
            const document = await db
              .collection(collections.orders)
              .findOne({ generation: target, orderId: order.id });
            assert.equal(document.readModelVersion, '18');
            return { generation: target };
          };
          await rebuilt.replay([...envelopes].reverse(), {
            generation: `${generation}-replay`,
            expectedOrderCount: 1,
          });
          const normalize = (row) => {
            const { _id, generation: _generation, ...rest } = row;
            return rest;
          };
          const live = await db
            .collection(collections.orders)
            .findOne({ generation, orderId: order.id });
          const replay = await db
            .collection(collections.orders)
            .findOne({ generation: `${generation}-replay`, orderId: order.id });
          assert.deepEqual(normalize(replay), normalize(live));
          const liveMovements = await db
            .collection(collections.movements)
            .find({ generation, orderId: order.id })
            .sort({ eventId: 1 })
            .toArray();
          const replayMovements = await db
            .collection(collections.movements)
            .find({ generation: `${generation}-replay`, orderId: order.id })
            .sort({ eventId: 1 })
            .toArray();
          assert.deepEqual(
            replayMovements.map(normalize),
            liveMovements.map(normalize),
          );
          throw rollback;
        }),
        (error) => {
          if (error !== rollback) throw error;
          return true;
        },
      );
      assert.deepEqual(await snapshot(), before);
      assert.equal(
        (await sql('SELECT id FROM service_orders WHERE id=$1', [orderId]))
          .length,
        0,
      );
      assert.deepEqual(
        await db
          .collection('service_order_projection_control_v1')
          .findOne({ _id: 'active' }),
        control,
      );
      for (const [name, rows] of Object.entries(mongoBefore))
        for (const row of rows)
          assert.deepEqual(
            await db.collection(name).findOne({ _id: row._id }),
            row,
          );
    } finally {
      if (channel) await channel.close();
      await connections.close();
      await Database.connection.close();
    }
  },
);
