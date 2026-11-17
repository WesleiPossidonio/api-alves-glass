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
import { createCqrsConnections } from '../../../src/config/cqrs.js';

test(
  'RF31 real PostgreSQL ownership and Mongo client DTO, paging and canonical state protection',
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
    const connections = createCqrsConnections();
    const generation = `rf31-${randomUUID()}`;
    const projection = new Projection({
      connections,
      generation,
      cursorSecret: 'rf31-recovery-cursor',
    });
    const sql = async (query, bind = [], transaction) =>
      (await Database.connection.query(query, { bind, transaction }))[0];
    const snapshot = async () => {
      const result = {};
      for (const table of [
        'client',
        'service_orders',
        'service_order_products',
        'service_order_events',
        'service_order_outbox',
      ])
        result[table] = await sql(
          `SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`,
        );
      return result;
    };
    const rollback = new Error('RF31 rollback-only fixture');
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
      await assert.rejects(
        Database.connection.transaction(async (transaction) => {
          const [reference] = await sql(
            'SELECT client_id,sector_id,created_by FROM service_orders ORDER BY id LIMIT 1',
            [],
            transaction,
          );
          const [other] = await sql(
            'SELECT id FROM client WHERE id<>$1 ORDER BY id LIMIT 1',
            [reference.client_id],
            transaction,
          );
          assert.ok(
            other,
            'Recovery needs two preexisting clients; never create permanent identity fixtures',
          );
          const ownIds = [];
          let foreign;
          for (const [index, status] of [
            'REGISTERED',
            'AWAITING_SUPPLIER',
            'IN_PRODUCTION',
            'AWAITING_DELIVERY',
            'COMPLETED',
            'CANCELLED',
            'IN_PRODUCTION',
          ].entries()) {
            const own = index !== 6;
            const order = await Orders.create(
              {
                clientId: own ? reference.client_id : other.id,
                sectorId: reference.sector_id,
                createdBy: reference.created_by,
                externalNumber: `000-RF31-${generation}-${index}`,
                dueAt: '2026-12-01',
              },
              { transaction },
            );
            const append = (eventType, payload) =>
              Events.append(
                {
                  aggregateId: order.id,
                  sectorId: reference.sector_id,
                  actorUserId: reference.created_by,
                  eventType,
                  payload,
                },
                { transaction },
              );
            await append('ServiceOrderRegistered', {
              clientId: order.client_id,
              externalNumber: order.external_number,
            });
            await append('ServiceOrderFunctionalStatusChanged', { status });
            await sql(
              'UPDATE service_orders SET functional_status=$1 WHERE id=$2',
              [status, order.id],
              transaction,
            );
            const envelopes = await sql(
              'SELECT payload FROM service_order_outbox WHERE aggregate_id=$1 ORDER BY aggregate_version',
              [order.id],
              transaction,
            );
            for (const row of envelopes)
              assert.equal(
                (await projection.apply(row.payload)).status,
                'APPLIED',
              );
            // Sensitive fixture fields prove response allowlisting; no canonical facts altered.
            await db.collection(collections.orders).updateOne(
              { generation, orderId: order.id },
              {
                $set: {
                  responsibleUserId: reference.created_by,
                  quality: [{ inspectorId: reference.created_by }],
                  priority: true,
                  products: [
                    {
                      name: 'Private',
                      measurements: { width: 100 },
                      movements: ['private'],
                    },
                  ],
                },
              },
            );
            if (own) ownIds.push(order.id);
            else foreign = order.id;
          }
          const read = new ReadService({
            projection,
            orders: {
              findById: (id) => Orders.findById(id, { transaction }),
              // Real canonical ownership filter; additional ID scope isolates rollback-only fixtures.
              findForClient: async (clientId, options) =>
                (
                  await Orders.findForClient(clientId, {
                    ...options,
                    limit: 10000,
                    transaction,
                  })
                )
                  .filter(
                    (row) => ownIds.includes(row.id) || row.id === foreign,
                  )
                  .slice(0, options.limit),
            },
            connections: {
              getMongoDatabase: async () => ({
                collection: (name) =>
                  name.includes('control')
                    ? { findOne: async () => ({ generation }) }
                    : db.collection(name),
              }),
            },
          });
          const actor = {
            id: reference.client_id,
            type: 'client',
            role: 'client',
          };
          const resultIds = [];
          const statuses = [];
          let cursor;
          do {
            const page = await read.getClientOrders({
              clientId: actor.id,
              actor,
              limit: 1,
              cursor,
            });
            assert.equal(page.serviceOrders.length, 1);
            for (const entry of page.serviceOrders) {
              assert.deepEqual(Object.keys(entry), ['order']);
              assert.deepEqual(Object.keys(entry.order).sort(), [
                'externalNumber',
                'id',
                'status',
              ]);
              assert.ok(entry.order.externalNumber.startsWith('000-RF31-'));
              resultIds.push(entry.order.id);
              statuses.push(entry.order.status);
            }
            cursor = page.nextCursor;
            if (cursor) {
              await assert.rejects(
                read.getClientOrders({
                  clientId: other.id,
                  actor: { ...actor, id: other.id },
                  cursor,
                }),
                { code: 'cursorInvalid' },
              );
            }
          } while (cursor);
          assert.deepEqual(new Set(resultIds), new Set(ownIds));
          assert.equal(resultIds.length, 6);
          assert.deepEqual(
            new Set(statuses),
            new Set([
              'Pedido cadastrado',
              'Aguardando fornecedor',
              'Em produção',
              'Aguardando entrega/instalação',
              'Concluído',
              'Cancelado',
            ]),
          );
          const mixed = await read.getClientOrders({
            clientId: actor.id,
            actor,
            limit: 100,
          });
          assert.equal(mixed.serviceOrders.length, 6);
          assert.equal(mixed.nextCursor, null);
          assert.deepEqual(
            new Set(mixed.serviceOrders.map((entry) => entry.order.status)),
            new Set(statuses),
          );
          await assert.rejects(
            read.getOrder({ orderId: foreign, actor, client: true }),
            { code: 'serviceOrderNotFound' },
          );
          const victim = ownIds[1];
          await db
            .collection(collections.orders)
            .updateOne(
              { generation, orderId: foreign },
              { $set: { clientId: actor.id } },
            );
          await assert.rejects(
            read.getOrder({ orderId: foreign, actor, client: true }),
            { code: 'serviceOrderNotFound' },
          );
          await db
            .collection(collections.orders)
            .updateOne(
              { generation, orderId: victim },
              { $set: { readModelVersion: '1' } },
            );
          await assert.rejects(
            read.getOrder({ orderId: victim, actor, client: true }),
            { code: 'projectionPending' },
          );
          await db
            .collection(collections.orders)
            .updateOne(
              { generation, orderId: victim },
              { $set: { readModelVersion: '2' } },
            );
          for (const status of [
            'CREATED',
            'APPROVED',
            'MATERIALS_SEPARATED',
            'IN_ROUTE',
            'DELIVERED',
            'UNKNOWN',
          ]) {
            assert.throws(() => read.clientMilestone(status), {
              code: 'clientStatusMappingPending',
            });
            await db
              .collection(collections.orders)
              .updateOne(
                { generation, orderId: victim },
                { $set: { status, publicStatus: 'IN_PRODUCTION' } },
              );
            await assert.rejects(
              read.getOrder({ orderId: victim, actor, client: true }),
              { code: 'projectionPending' },
            );
          }
          throw rollback;
        }),
        (error) => {
          if (error !== rollback) throw error;
          return true;
        },
      );
      assert.deepEqual(await snapshot(), before);
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
      await connections.close();
      await Database.connection.close();
    }
  },
);
