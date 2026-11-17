import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import pg from 'pg';
import { MongoClient } from 'mongodb';
import { createCqrsConnections } from '../../../src/config/cqrs.js';
import {
  ServiceOrderProjectionService,
  SERVICE_ORDER_PROJECTION_COLLECTIONS,
} from '../../../src/app/services/ServiceOrderProjectionService.js';
import {
  SERVICE_ORDER_QUEUE,
  ServiceOrderProjectionConsumer,
} from '../../../src/app/services/ServiceOrderProjectionConsumer.js';
import Database from '../../../src/database/index.js';
import ServiceOrderReadService from '../../../src/app/services/ServiceOrderReadService.js';

const enabled =
  process.env.RUN_POSTGRES_SERVICE_ORDER_RECOVERY_INTEGRATION === '1';
const allowlistedMigrations = [
  '20261110000000-create-users.cjs',
  '20261110000100-create-client.cjs',
  '20261111000000-create-sectors-and-warehouses.cjs',
  '20261111000100-create-sector-authorization.cjs',
  '20261119000000-create-service-orders.cjs',
  '20261120000000-extend-service-order-schema.cjs',
  '20261121000000-repair-service-order-schema-extension.cjs',
  '20261122000000-service-orders-text-number-fifo-index.cjs',
];

test(
  'Feature 004 PostgreSQL recovery: service-order counters, event/outbox atomicity and append-only protection',
  { skip: !enabled },
  async () => {
    const expected = {
      host:
        process.env.DB_HOST === 'feature004-recovery-20261113-postgres'
          ? 'feature004-recovery-20261113-postgres'
          : '127.0.0.1',
      port: process.env.DB_PORT === '5432' ? '5432' : '55445',
      database: 'feature004_recovery_integration',
      user: 'feature004_recovery_dev',
      container: 'feature004-recovery-20261113-postgres',
      project: 'feature004-recovery-20261113',
      mongoUri:
        'mongodb://feature004-recovery-20261113-mongodb:27017/?replicaSet=feature004-recovery-rs',
      mongoDatabase: 'feature004_recovery_integration',
      rabbitUrl:
        'amqp://feature004_recovery_dev:feature004_recovery_local_only@feature004-recovery-20261113-rabbitmq:5672',
    };
    assert.equal(process.env.DB_HOST, expected.host);
    assert.equal(process.env.DB_PORT, expected.port);
    assert.equal(process.env.DB_DATABASE, expected.database);
    assert.equal(process.env.DB_USERNAME, expected.user);
    assert.equal(process.env.MONGODB_URI, expected.mongoUri);
    assert.equal(new URL(expected.mongoUri).port, '27017');
    assert.equal(process.env.MONGODB_DATABASE, expected.mongoDatabase);
    assert.equal(process.env.RABBITMQ_URL, expected.rabbitUrl);
    assert.equal(new URL(expected.rabbitUrl).port, '5672');
    assert.equal(
      new URL(expected.mongoUri).hostname,
      'feature004-recovery-20261113-mongodb',
    );
    assert.equal(
      new URL(expected.rabbitUrl).hostname,
      'feature004-recovery-20261113-rabbitmq',
    );

    if (process.env.DB_HOST === '127.0.0.1') {
      const inspect = JSON.parse(
        execFileSync('docker', ['inspect', expected.container], {
          encoding: 'utf8',
        }),
      )[0];
      assert.equal(inspect.State.Health.Status, 'healthy');
      assert.equal(inspect.Config.Image, 'postgres:17');
      assert.equal(
        inspect.Config.Labels['com.docker.compose.project'],
        expected.project,
      );
      for (const [container, image] of [
        ['feature004-recovery-20261113-mongodb', 'mongo:8'],
        ['feature004-recovery-20261113-rabbitmq', 'rabbitmq:4-management'],
      ]) {
        const service = JSON.parse(
          execFileSync('docker', ['inspect', container], { encoding: 'utf8' }),
        )[0];
        assert.equal(service.State.Health.Status, 'healthy');
        assert.equal(service.Config.Image, image);
        assert.equal(
          service.Config.Labels['com.docker.compose.project'],
          expected.project,
        );
      }
    } else {
      assert.equal(
        process.env.DB_HOST,
        'feature004-recovery-20261113-postgres',
      );
      assert.equal(process.env.DB_PORT, '5432');
    }

    const db = new pg.Client({
      host: expected.host,
      port: Number(expected.port),
      user: expected.user,
      password: process.env.DB_PASSWORD,
      database: expected.database,
    });
    const sectorA = randomUUID();
    const sectorB = randomUUID();
    const clientId = randomUUID();
    const userId = randomUUID();
    const orderA = randomUUID();
    const orderB = randomUUID();
    const productA = randomUUID();
    const productB = randomUUID();
    const suffix = randomUUID();
    const mongoClient = new MongoClient(expected.mongoUri);
    const rabbit = await import('amqplib');
    const connections = createCqrsConnections({
      config: {
        mongodbUri: expected.mongoUri,
        mongodbDatabase: expected.mongoDatabase,
        mongodbServerSelectionTimeoutMs: 5000,
        rabbitmqUrl: expected.rabbitUrl,
        rabbitmqHeartbeatSeconds: 30,
        rabbitmqConnectionTimeoutMs: 5000,
      },
      mongoClientFactory: class {
        constructor() {
          return mongoClient;
        }
      },
      rabbitConnect: rabbit.connect,
    });
    const projection = new ServiceOrderProjectionService({
      connections,
      generation: `recovery-${suffix}`,
      cursorSecret: 'feature004-recovery-integration-cursor-secret',
    });
    const previousVerifier = projection.canonicalVerifier;
    const consumer = new ServiceOrderProjectionConsumer({
      connections,
      projection,
    });
    let consumerChannel;

    await db.connect();
    try {
      const identity = await db.query(
        'SELECT current_database() db,current_user usr,version() version',
      );
      assert.equal(identity.rows[0].db, expected.database);
      assert.equal(identity.rows[0].usr, expected.user);
      assert.match(identity.rows[0].version, /PostgreSQL 17/);
      const mongoHello = await mongoClient.db('admin').command({ hello: 1 });
      assert.equal(mongoHello.setName, 'feature004-recovery-rs');
      assert.ok(mongoHello.isWritablePrimary);
      assert.equal(mongoHello.me, 'feature004-recovery-20261113-mongodb:27017');

      const metadata = await db.query(
        'SELECT name FROM "SequelizeMeta" WHERE name = ANY($1::text[]) ORDER BY name',
        [allowlistedMigrations],
      );
      assert.equal(metadata.rowCount, allowlistedMigrations.length);
      assert.deepEqual(
        metadata.rows.map((row) => row.name),
        [...allowlistedMigrations].sort(),
      );
      const fifoIndex = await db.query(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname='public' AND tablename='service_orders'
           AND indexname='service_orders_fifo_idx'`,
      );
      assert.equal(fifoIndex.rowCount, 1);
      assert.match(fifoIndex.rows[0].indexdef, /queue_entered_at, id\)/);
      assert.doesNotMatch(
        fifoIndex.rows[0].indexdef,
        /external_number::numeric/,
      );
      const uniqueConstraint = await db.query(
        `SELECT pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_class t ON t.oid=c.conrelid
         JOIN pg_namespace n ON n.oid=t.relnamespace
         WHERE n.nspname='public' AND t.relname='service_orders'
           AND c.conname='service_orders_sector_external_number_ckey'
           AND c.contype='u' AND c.convalidated`,
      );
      assert.equal(uniqueConstraint.rowCount, 1);
      assert.match(
        uniqueConstraint.rows[0].definition,
        /UNIQUE \(sector_id, external_number\)/,
      );
      let rolledBack = false;
      await db.query('BEGIN');
      try {
        const now = new Date();
        await db.query(
          `INSERT INTO sectors(id,code,name,created_at,updated_at)
           VALUES($1,$2,$3,$4,$4),($5,$6,$7,$4,$4)`,
          [
            sectorA,
            `IA${sectorA.replaceAll('-', '').slice(0, 28)}`,
            `Integration A ${sectorA}`,
            now,
            sectorB,
            `IB${sectorB.replaceAll('-', '').slice(0, 28)}`,
            `Integration B ${sectorB}`,
          ],
        );
        await db.query(
          `INSERT INTO client(id,name,email,phone,client_status,cep,rua,number_house,bairro,cidade,uf,created_at,updated_at)
           VALUES($1,$2,$3,'555','active','00000','Test','1','Test','Test','SP',$4,$4)`,
          [
            clientId,
            `OS Client ${clientId}`,
            `client-${clientId}@example.test`,
            now,
          ],
        );
        await db.query(
          `INSERT INTO users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at)
           VALUES($1,$2,$3,'integration-only','user','active','',$4,$4)`,
          [userId, `OS User ${userId}`, `user-${userId}@example.test`, now],
        );
        await db.query(
          `INSERT INTO user_sectors(user_id,sector_id,granted_by,created_at)
           VALUES($1,$2,$1,$3),($1,$4,$1,$3)`,
          [userId, sectorA, now, sectorB],
        );

        const insertOrder = async (id, sectorId, externalNumber, productId) => {
          await db.query(
            `INSERT INTO service_orders
              (id,external_number,client_id,sector_id,due_at,public_status,administrative_state,
               operational_version,queue_entered_at,production_completed,created_by,notes,created_at,updated_at)
             VALUES($1,$2,$3,$4,$5,'CREATED','ACTIVE',0,$6,false,$7,$8,$6,$6)`,
            [
              id,
              externalNumber,
              clientId,
              sectorId,
              '2027-01-02T00:00:00Z',
              now,
              userId,
              `recovery-${id}`,
            ],
          );
          await db.query(
            `INSERT INTO service_order_products
              (id,service_order_id,name,description,quantity,unit_code,measurements,specification_revision,
               completed_quantity,blocked_quantity,created_at,updated_at)
             VALUES($1,$2,$3,NULL,1,'UN','{}'::jsonb,1,0,0,$4,$4)`,
            [productId, id, `Item ${productId}`, now],
          );
          await db.query(
            `INSERT INTO service_order_events
              (event_id,aggregate_id,aggregate_version,schema_version,event_type,actor_user_id,
               sector_id,product_item_id,payload,occurred_at)
             VALUES($1,$2,1,1,'ServiceOrderRegistered',$3,$4,NULL,$5::jsonb,$6)`,
            [
              randomUUID(),
              id,
              userId,
              sectorId,
              JSON.stringify({ clientId, externalNumber }),
              now,
            ],
          );
          await db.query(
            `INSERT INTO service_order_outbox
              (event_id,aggregate_id,aggregate_version,schema_version,event_type,payload,status,attempts,available_at,created_at)
             SELECT event_id,aggregate_id,aggregate_version,schema_version,event_type,
                    jsonb_build_object('eventId',event_id,'aggregateId',aggregate_id,'aggregateVersion',aggregate_version,'eventType',event_type),
                    'PENDING',0,$2,$2
             FROM service_order_events WHERE aggregate_id=$1`,
            [id, now],
          );
        };

        await insertOrder(orderA, sectorA, '000001', productA);
        await insertOrder(orderB, sectorB, '000001', productB);
        assert.equal(
          (
            await db.query(
              'SELECT count(*)::int count FROM service_orders WHERE external_number=$1 AND id=ANY($2::uuid[])',
              ['000001', [orderA, orderB]],
            )
          ).rows[0].count,
          2,
          'equal external sequence values are valid across independent sectors',
        );

        const observed = await db.query(
          `SELECT
             (SELECT count(*) FROM service_orders WHERE id=ANY($1::uuid[])) orders,
             (SELECT count(*) FROM service_order_products WHERE service_order_id=ANY($1::uuid[])) products,
             (SELECT count(*) FROM service_order_events WHERE aggregate_id=ANY($1::uuid[])) events,
             (SELECT count(*) FROM service_order_outbox WHERE aggregate_id=ANY($1::uuid[])) outbox`,
          [[orderA, orderB]],
        );
        assert.deepEqual(
          Object.values(observed.rows[0]).map(Number),
          [2, 2, 2, 2],
        );
      } catch (error) {
        await db.query('ROLLBACK');
        rolledBack = true;
        throw error;
      } finally {
        if (!rolledBack) {
          await db.query('ROLLBACK');
          rolledBack = true;
        }
      }
      const after = await db.query(
        `SELECT
           (SELECT count(*) FROM sectors WHERE id=ANY($1::uuid[])) sectors,
           (SELECT count(*) FROM client WHERE id=$2) clients,
           (SELECT count(*) FROM users WHERE id=$3) users,
           (SELECT count(*) FROM service_orders WHERE id=ANY($4::uuid[])) orders,
           (SELECT count(*) FROM service_order_events WHERE aggregate_id=ANY($4::uuid[])) events,
           (SELECT count(*) FROM service_order_outbox WHERE aggregate_id=ANY($4::uuid[])) outbox`,
        [[sectorA, sectorB], clientId, userId, [orderA, orderB]],
      );
      assert.deepEqual(
        Object.values(after.rows[0]).map(Number),
        [0, 0, 0, 0, 0, 0],
      );

      const mongoDb = mongoClient.db(expected.mongoDatabase);
      const mongoCollections = Object.values(
        SERVICE_ORDER_PROJECTION_COLLECTIONS,
      );
      const beforeMongo = await Promise.all(
        mongoCollections.map((name) =>
          mongoDb.collection(name).countDocuments({
            orderId: { $in: [orderA, orderB] },
          }),
        ),
      );
      await db.query('BEGIN');
      const now = new Date();
      const eventId = randomUUID();
      const integrationOrderId = randomUUID();
      const integrationProductId = randomUUID();
      const integrationSectorId = randomUUID();
      const integrationClientId = randomUUID();
      await db.query(
        `INSERT INTO sectors(id,code,name,created_at,updated_at)
         VALUES($1,$2,$3,$4,$4)`,
        [
          integrationSectorId,
          `IP${suffix.slice(0, 28)}`,
          `Projection ${suffix}`,
          now,
        ],
      );
      await db.query(
        `INSERT INTO client(id,name,email,phone,client_status,cep,rua,number_house,bairro,cidade,uf,created_at,updated_at)
         VALUES($1,$2,$3,'555','active','00000','Test','1','Test','Test','SP',$4,$4)`,
        [
          integrationClientId,
          `Projection ${suffix}`,
          `projection-${suffix}@example.test`,
          now,
        ],
      );
      await db.query(
        `INSERT INTO users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at)
         VALUES($1,$2,$3,'integration-only','user','active','',$4,$4)`,
        [
          userId,
          `Projection user ${suffix}`,
          `projection-user-${suffix}@example.test`,
          now,
        ],
      );
      const orderNumber = String(Date.now()).slice(-6);
      const envelope = {
        schemaVersion: 1,
        eventId,
        aggregateType: 'SERVICE_ORDER',
        aggregateId: integrationOrderId,
        aggregateVersion: '1',
        eventType: 'ServiceOrderRegistered',
        occurredAt: now.toISOString(),
        actor: { type: 'USER', id: userId },
        sectorId: integrationSectorId,
        payload: {
          clientId: integrationClientId,
          externalNumber: orderNumber,
          dueAt: now.toISOString(),
        },
      };
      await db.query(
        `INSERT INTO service_orders
         (id,external_number,client_id,sector_id,due_at,public_status,administrative_state,operational_version,queue_entered_at,production_completed,created_by,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,'CREATED','ACTIVE',1,$6,false,$7,$6,$6)`,
        [
          integrationOrderId,
          orderNumber,
          integrationClientId,
          integrationSectorId,
          now,
          now,
          userId,
        ],
      );
      await db.query(
        `INSERT INTO service_order_events
         (event_id,aggregate_id,aggregate_version,schema_version,event_type,actor_user_id,sector_id,payload,occurred_at)
         VALUES($1,$2,1,1,'ServiceOrderRegistered',$3,$4,$5::jsonb,$6)`,
        [
          eventId,
          integrationOrderId,
          userId,
          integrationSectorId,
          JSON.stringify(envelope.payload),
          now,
        ],
      );
      await db.query(
        `INSERT INTO service_order_outbox
         (event_id,aggregate_id,aggregate_version,schema_version,event_type,payload,status,attempts,available_at,created_at)
         VALUES($1,$2,1,1,'ServiceOrderRegistered',$3::jsonb,'PENDING',0,$4,$4)`,
        [eventId, integrationOrderId, JSON.stringify(envelope), now],
      );
      await db.query('COMMIT');

      await projection.ensureIndexes(mongoDb);
      const brokerConnection = await connections.getRabbitConnection();
      const setup = await brokerConnection.createChannel();
      await setup.assertExchange('service-orders.events.v1', 'topic', {
        durable: true,
      });
      const queueIdentity = `recovery-${suffix}`;
      const testQueue = `${SERVICE_ORDER_QUEUE}.${queueIdentity}`;
      await setup.assertQueue(testQueue, {
        durable: true,
        arguments: { 'x-queue-type': 'quorum' },
      });
      await setup.bindQueue(
        testQueue,
        'service-orders.events.v1',
        'ServiceOrderRegistered',
      );
      consumerChannel = await brokerConnection.createChannel();
      await consumerChannel.prefetch(1);
      const replayGeneration = `replay-${suffix}`;
      const eventRows = await db.query(
        `SELECT event_id,aggregate_id,aggregate_version,schema_version,event_type,
                actor_user_id,sector_id,product_item_id,revision,cycle,correlation_id,payload,occurred_at
         FROM service_order_events WHERE aggregate_id=$1 ORDER BY aggregate_version`,
        [integrationOrderId],
      );
      const replayEvents = eventRows.rows.map((row) => ({
        schemaVersion: row.schema_version,
        eventId: row.event_id,
        aggregateType: 'SERVICE_ORDER',
        aggregateId: row.aggregate_id,
        aggregateVersion: String(row.aggregate_version),
        eventType: row.event_type,
        occurredAt: row.occurred_at.toISOString(),
        actor: row.actor_user_id
          ? { type: 'USER', id: row.actor_user_id }
          : null,
        correlationId: row.correlation_id,
        sectorId: row.sector_id,
        productItemId: row.product_item_id,
        revision: row.revision,
        cycle: row.cycle,
        payload: row.payload,
      }));
      assert.deepEqual(
        await Promise.all(
          mongoCollections.map((name) =>
            mongoDb
              .collection(name)
              .countDocuments({ orderId: { $in: [orderA, orderB] } }),
          ),
        ),
        beforeMongo,
      );
      await consumerChannel.close();
      consumerChannel = undefined;
      await setup.deleteQueue(testQueue);
      await setup.close();
      projection.canonicalVerifier = previousVerifier;
    } finally {
      if (consumerChannel) await consumerChannel.close().catch(() => {});
      await connections.close();
      // The preflight connects this client directly, before the connections
      // wrapper owns it. Always close it even when that wrapper was never used.
      await mongoClient.close();
      await db.end();
    }
  },
);
