import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import Sequelize from 'sequelize';
import amqp from 'amqplib';
import { ServiceOrderOutboxPublisher } from '../../../src/app/services/ServiceOrderOutboxPublisher.js';
import { ServiceOrderProjectionConsumer } from '../../../src/app/services/ServiceOrderProjectionConsumer.js';
import { SERVICE_ORDER_QUEUE } from '../../../src/app/services/serviceOrderMessagingTopology.js';

const require = createRequire(import.meta.url);
const enabled = process.env.RUN_FEATURE004_PR5_REGRESSION === '1';
const migrationDirectory = new URL(
  '../../../src/database/migrations/',
  import.meta.url,
);

function preflight() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DB_HOST, '127.0.0.1');
  assert.equal(process.env.DB_PORT, '55446');
  assert.match(
    process.env.DB_DATABASE,
    /^feature004_pr5_regression(?:_[0-9]+)?$/,
  );
  assert.equal(process.env.DB_USERNAME, 'feature004_pr5_test');
  assert.match(
    process.env.RABBITMQ_URL,
    /^amqp:\/\/feature004_pr5_test:feature004_pr5_local_only@127\.0\.0\.1:5681\/feature004_pr5_regression(?:_[0-9]+)?$/,
  );
}

test(
  'PR5 fresh PostgreSQL bootstrap, real transitions and publisher-before-consumer delivery',
  { skip: !enabled },
  async (t) => {
    preflight();
    const db = new Sequelize(
      process.env.DB_DATABASE,
      process.env.DB_USERNAME,
      process.env.DB_PASSWORD,
      {
        dialect: 'postgres',
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        logging: false,
      },
    );
    t.after(() => db.close());
    const qi = db.getQueryInterface();
    const [identity] = await db.query(
      'SELECT current_database() db, current_user usr, version() version',
    );
    assert.equal(identity[0].db, process.env.DB_DATABASE);
    assert.equal(identity[0].usr, 'feature004_pr5_test');
    assert.match(identity[0].version, /PostgreSQL 17/);
    const [tables] = await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    );
    assert.deepEqual(
      tables,
      [],
      'Only a new empty authorized target may bootstrap',
    );
    await db.query(
      'CREATE TABLE "SequelizeMeta" (name varchar(255) PRIMARY KEY)',
    );
    const prerequisites = [
      '20261110000000-create-users.cjs',
      '20261110000100-create-client.cjs',
      '20261111000000-create-sectors-and-warehouses.cjs',
      '20261111000100-create-sector-authorization.cjs',
    ];
    const featureMigrations = (await readdir(migrationDirectory))
      .filter((name) => /^202611(19|20|21|22|23|24|25|26)000000-/.test(name))
      .sort();
    assert.equal(featureMigrations.length, 8);
    for (const name of [...prerequisites, ...featureMigrations]) {
      await require(new URL(name, migrationDirectory).pathname).up(
        qi,
        Sequelize,
      );
      await db.query('INSERT INTO "SequelizeMeta" (name) VALUES (:name)', {
        replacements: { name },
      });
      t.diagnostic(`APPLIED ${name}`);
      if (name === '20261121000000-repair-service-order-schema-extension.cjs') {
        const repair = require(new URL(name, migrationDirectory).pathname);
        for (const [sql, error] of [
          [
            'ALTER TABLE service_orders ADD COLUMN unexpected_pr5 integer',
            /baseline columns mismatch/,
          ],
          [
            'ALTER TABLE service_order_grant_events DISABLE TRIGGER service_order_grant_event_hash_before_insert',
            /partial or divergent/,
          ],
          [
            'DROP TRIGGER service_order_grant_event_hash_before_insert ON service_order_grant_events',
            /partial or divergent/,
          ],
          [
            'CREATE OR REPLACE FUNCTION set_service_order_grant_event_hash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$',
            /partial or divergent/,
          ],
        ]) {
          const probe = await db.transaction();
          try {
            await db.query(sql, { transaction: probe });
            const scoped = {
              sequelize: {
                transaction: (fn) => fn(probe),
                query: (statement, options) =>
                  db.query(statement, { ...options, transaction: probe }),
              },
            };
            await assert.rejects(repair.up(scoped), error);
          } finally {
            await probe.rollback();
          }
        }
        t.diagnostic(
          'REPAIR rejects divergent columns, disabled/missing trigger and altered function; probes rolled back',
        );
      }
    }

    const { serviceOrderService } = await import(
      '../../../src/app/services/ServiceOrderService.js'
    );
    const Database = (await import('../../../src/database/index.js')).default;
    t.after(() => Database.connection.close());
    const actorId = randomUUID(),
      clientId = randomUUID(),
      sectorId = randomUUID(),
      workerId = randomUUID();
    await db.query(
      `INSERT INTO users(id,name,email,password_hash,created_at,updated_at) VALUES(:actor,'PR5 admin','pr5-admin@test.invalid','test-only',now(),now()),(:worker,'PR5 worker','pr5-worker@test.invalid','test-only',now(),now());
    INSERT INTO client(id,name,email,phone,cep,rua,number_house,bairro,cidade,uf,created_at,updated_at) VALUES(:client,'PR5 client','pr5-client@test.invalid','0','0','test','0','test','test','TS',now(),now());
    INSERT INTO sectors(id,code,name,created_at,updated_at) VALUES(:sector,'PR5','PR5',now(),now());
    INSERT INTO user_sectors(user_id,sector_id,granted_by,created_at) VALUES(:actor,:sector,:actor,now()),(:worker,:sector,:actor,now())`,
      {
        replacements: {
          actor: actorId,
          worker: workerId,
          client: clientId,
          sector: sectorId,
        },
      },
    );
    const actor = { id: actorId, type: 'user', role: 'admin' };
    const orderId = randomUUID(),
      productId = randomUUID();
    await db.query(
      `INSERT INTO service_orders(id,external_number,client_id,sector_id,due_at,public_status,functional_status,created_by) VALUES(:order,'PR5-1',:client,:sector,now(),'CREATED','REGISTERED',:actor);
    INSERT INTO service_order_products(id,service_order_id,name,quantity) VALUES(:product,:order,'PR5 product',10)`,
      {
        replacements: {
          order: orderId,
          client: clientId,
          sector: sectorId,
          actor: actorId,
          product: productId,
        },
      },
    );
    await serviceOrderService.transitionFunctionalStatus(
      orderId,
      'IN_PRODUCTION',
      actor,
    );
    const [transition] = await db.query(
      "SELECT payload FROM service_order_events WHERE aggregate_id=:order AND event_type='ServiceOrderFunctionalStatusChanged'",
      { replacements: { order: orderId } },
    );
    assert.deepEqual(transition[0].payload, {
      previousStatus: 'REGISTERED',
      status: 'IN_PRODUCTION',
    });
    t.diagnostic(
      'REAL_TRANSITION previousStatus=REGISTERED status=IN_PRODUCTION',
    );

    const rabbit = await amqp.connect(process.env.RABBITMQ_URL);
    t.after(() => rabbit.close());
    const absentQueueProbe = await rabbit.createChannel();
    absentQueueProbe.on('error', () => {});
    await assert.rejects(
      absentQueueProbe.checkQueue(SERVICE_ORDER_QUEUE),
      /404/,
    );
    t.diagnostic(
      'RABBIT_PREFLIGHT projection queue absent before publisher startup',
    );
    const connections = { getRabbitConnection: async () => rabbit };
    const publisher = new ServiceOrderOutboxPublisher({ connections });
    assert.deepEqual(await publisher.publishBatch(), {
      claimed: 1,
      published: 1,
    });
    const inspect = await rabbit.createChannel();
    t.after(() => inspect.close().catch(() => {}));
    assert.equal(
      (await inspect.checkQueue(SERVICE_ORDER_QUEUE)).messageCount,
      1,
    );
    t.diagnostic('PUBLISHER_BEFORE_CONSUMER durable queue contains 1 event');
    let consumed;
    const delivered = new Promise((resolve) => {
      consumed = resolve;
    });
    const consumer = new ServiceOrderProjectionConsumer({
      connections: { ...connections, getMongoDatabase: async () => ({}) },
      projection: {
        ensureIndexes: async () => {},
        apply: async (event) => {
          consumed(event);
          return { status: 'APPLIED' };
        },
      },
    });
    const consumerChannel = await consumer.start();
    t.after(() => consumerChannel.close().catch(() => {}));
    const event = await Promise.race([
      delivered,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('delivery timeout')),
          10000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(event.aggregateId, orderId);
    assert.equal(event.aggregateVersion, '1');

    // Remove only our new target's binding after topology declaration to force a real basic.return.
    const routingFailure = new ServiceOrderOutboxPublisher({ connections });
    const open = routingFailure.openConfirmChannel.bind(routingFailure);
    routingFailure.openConfirmChannel = async () => {
      const channel = await open();
      await channel.unbindQueue(
        SERVICE_ORDER_QUEUE,
        'service-orders.events.v1',
        '#',
      );
      return channel;
    };
    // Append a new canonical fact through the real event repository, atomically with its Outbox.
    const events = (
      await import(
        '../../../src/app/repositories/ServiceOrderEventRepository.js'
      )
    ).default;
    await Database.connection.transaction((transaction) =>
      events.append(
        {
          aggregateId: orderId,
          sectorId,
          actorUserId: actorId,
          eventType: 'ServiceOrderPriorityChanged',
          payload: { priority: true },
        },
        { transaction },
      ),
    );
    assert.deepEqual(await routingFailure.publishBatch(), {
      claimed: 1,
      published: 0,
    });
    const [retry] = await db.query(
      'SELECT status,attempts,last_error FROM service_order_outbox WHERE aggregate_id=:order AND aggregate_version=2',
      { replacements: { order: orderId } },
    );
    assert.equal(retry[0].status, 'PENDING');
    assert.equal(retry[0].attempts, 1);
    assert.match(retry[0].last_error, /unroutable/);
    t.diagnostic(
      'UNROUTABLE canonical version 2 retained; Outbox=PENDING attempts=1',
    );

    // Exercise the existing application method directly, without exposing a new HTTP endpoint.
    const permissions = (
      await import(
        '../../../src/app/repositories/ServiceOrderPermissionRepository.js'
      )
    ).default;
    await Database.connection.transaction((transaction) =>
      permissions.grant(
        {
          userId: workerId,
          sectorId,
          operation: 'RECORD_EXECUTION',
          actorId,
          reason: 'PR5 regression',
        },
        { transaction },
      ),
    );
    const assignmentIds = [randomUUID(), randomUUID()];
    for (const id of assignmentIds)
      await db.query(
        `INSERT INTO service_order_assignments(id,service_order_id,product_id,sector_id,assigned_user_id,assigned_by,quantity,remaining_quantity) VALUES(:id,:order,:product,:sector,:worker,:actor,5,5)`,
        {
          replacements: {
            id,
            order: orderId,
            product: productId,
            sector: sectorId,
            worker: workerId,
            actor: actorId,
          },
        },
      );
    for (const assignmentId of assignmentIds)
      await serviceOrderService.recordExecution(
        { assignmentId, quantity: 5 },
        { id: workerId, type: 'user', role: 'user' },
      );
    const [canonical] = await db.query(
      'SELECT completed_quantity FROM service_order_products WHERE id=:product',
      { replacements: { product: productId } },
    );
    const [progress] = await db.query(
      "SELECT payload,product_item_id FROM service_order_events WHERE aggregate_id=:order AND event_type='WorkProgressRecorded' ORDER BY aggregate_version",
      { replacements: { order: orderId } },
    );
    assert.equal(canonical[0].completed_quantity, 10);
    assert.deepEqual(
      progress.map(({ payload }) => payload.assignmentExecutedQuantity),
      [5, 5],
    );
    assert.deepEqual(
      progress.map(({ payload }) => payload.completedQuantity),
      [5, 10],
    );
    const Projection = (
      await import('../../../src/app/services/ServiceOrderProjectionService.js')
    ).default;
    const projection = new Projection();
    let projected = {
      products: [{ itemId: productId, quantity: 10, completedQuantity: 0 }],
      administrativeState: 'ACTIVE',
    };
    for (const event of progress)
      projected = projection.reduce(projected, {
        eventType: 'WorkProgressRecorded',
        productItemId: event.product_item_id,
        payload: event.payload,
      });
    assert.equal(projected.products[0].completedQuantity, 10);
    t.diagnostic(
      'TWO_ASSIGNMENTS canonical=10 eventTotals=[5,10] assignmentTotals=[5,5] projection=10',
    );
  },
);
