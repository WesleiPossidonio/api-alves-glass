import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import Database from '../../../src/database/index.js';
import { serviceOrderService as service } from '../../../src/app/services/ServiceOrderService.js';
import ServiceOrderOutbox from '../../../src/app/models/ServiceOrderOutbox.js';
import { ServiceOrderProjectionService } from '../../../src/app/services/ServiceOrderProjectionService.js';

test(
  'RF-21/RF-22 explicit confirmations, quality gate, transactional outbox, terminal release and concurrency',
  {
    skip: process.env.RUN_POSTGRES_SERVICE_ORDER_RECOVERY_INTEGRATION !== '1',
  },
  async () => {
    assert.equal(process.env.DB_HOST, 'feature004-recovery-20261113-postgres');
    assert.equal(process.env.DB_DATABASE, 'feature004_recovery_integration');
    const db = new pg.Client({
      host: process.env.DB_HOST,
      port: 5432,
      database: process.env.DB_DATABASE,
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
    });
    await db.connect();
    const confirmed = { confirmed: true };
    const ids = Object.fromEntries(
      ['sector', 'client', 'admin', 'worker', 'inspector', 'outsider'].map(
        (name) => [name, randomUUID()],
      ),
    );
    const admin = { id: ids.admin, type: 'user', role: 'admin' };
    const inspector = { id: ids.inspector, type: 'user', role: 'user' };
    const worker = { id: ids.worker, type: 'user', role: 'user' };
    const now = new Date();
    const snapshot = async () => {
      const result = {};
      for (const table of [
        'service_orders',
        'service_order_products',
        'service_order_qualities',
        'service_order_events',
        'service_order_outbox',
        'service_order_responsibilities',
        'service_order_cycles',
      ]) {
        result[table] = (
          await db.query(`SELECT to_jsonb(t) value FROM ${table} t`)
        ).rows.map(({ value }) => value);
      }
      return result;
    };
    try {
      assert.equal(
        (await db.query('SELECT current_database() db')).rows[0].db,
        'feature004_recovery_integration',
      );
      const before = await snapshot();
      // Two successful terminal outcomes need two OS; failed attempts add no fixtures.
      await Database.connection.transaction(async (transaction) => {
        const query = (sql, bind) =>
          Database.connection.query(sql, { bind, transaction });
        await query(
          'INSERT INTO sectors(id,code,name,created_at,updated_at) VALUES($1,$2,$3,$4,$4)',
          [ids.sector, `F${ids.sector.slice(0, 20)}`, 'RF21-22 isolated', now],
        );
        await query(
          "INSERT INTO client(id,name,email,phone,client_status,cep,rua,number_house,bairro,cidade,uf,created_at,updated_at) VALUES($1,$2,$2,'555','active','00000','test','1','test','test','SP',$3,$3)",
          [ids.client, `${ids.client}@completion.test`, now],
        );
        for (const name of ['admin', 'worker', 'inspector', 'outsider']) {
          await query(
            "INSERT INTO users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at) VALUES($1,$2,$2,'test-only','user','active','',$3,$3)",
            [ids[name], `${ids[name]}@completion.test`, now],
          );
          if (name !== 'outsider')
            await query(
              'INSERT INTO user_sectors(user_id,sector_id,granted_by,created_at) VALUES($1,$2,$3,$4)',
              [ids[name], ids.sector, ids.admin, now],
            );
        }
        for (const [userId, operation] of [
          [ids.inspector, 'RECORD_QUALITY'],
          [ids.worker, 'CLOSE'],
        ]) {
          await service.permissions.grant(
            {
              userId,
              sectorId: ids.sector,
              operation,
              actorId: ids.admin,
              reason: 'RF21-22 integration',
            },
            { transaction },
          );
        }
      });
      const createOrder = async (pending) => {
        const order = {
          id: randomUUID(),
          products: [randomUUID(), randomUUID()],
          qualities: [randomUUID(), randomUUID()],
        };
        await Database.connection.transaction(async (transaction) => {
          const query = (sql, bind) =>
            Database.connection.query(sql, { bind, transaction });
          await query(
            "INSERT INTO service_orders(id,external_number,client_id,sector_id,due_at,public_status,administrative_state,operational_version,queue_entered_at,production_completed,created_by,functional_status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'IN_PRODUCTION','ACTIVE',0,$5,false,$6,'IN_PRODUCTION',$5,$5)",
            [
              order.id,
              `RF21-22-${order.id}`,
              ids.client,
              ids.sector,
              now,
              ids.admin,
            ],
          );
          for (let index = 0; index < 2; index += 1) {
            await query(
              "INSERT INTO service_order_products(id,service_order_id,name,quantity,unit_code,measurements,specification_revision,completed_quantity,blocked_quantity,created_at,updated_at) VALUES($1,$2,'RF21-22',1,'UN','{}',1,1,0,$3,$3)",
              [order.products[index], order.id, now],
            );
            const open = pending && index === 1;
            await query(
              "INSERT INTO service_order_qualities(id,service_order_id,product_id,reported_by,issue,affected_quantity,approved_quantity,rejected_quantity,status,created_at,inspection_history) VALUES($1,$2,$3,$4,'RF21-22 fixture',1,$5,0,$6,$7,'[]')",
              [
                order.qualities[index],
                order.id,
                order.products[index],
                ids.worker,
                open ? 0 : 1,
                open ? 'OPEN' : 'APPROVED',
                now,
              ],
            );
          }
          await query(
            'INSERT INTO service_order_responsibilities(id,service_order_id,user_id,assigned_by,assigned_at) VALUES($1,$2,$3,$4,$5)',
            [randomUUID(), order.id, ids.worker, ids.admin, now],
          );
        });
        return order;
      };
      const state = async (id) => ({
        order: (
          await db.query('SELECT * FROM service_orders WHERE id=$1', [id])
        ).rows,
        responsibilities: (
          await db.query(
            'SELECT * FROM service_order_responsibilities WHERE service_order_id=$1 ORDER BY id',
            [id],
          )
        ).rows,
        events: (
          await db.query(
            'SELECT * FROM service_order_events WHERE aggregate_id=$1 ORDER BY aggregate_version',
            [id],
          )
        ).rows,
        outbox: (
          await db.query(
            'SELECT * FROM service_order_outbox WHERE aggregate_id=$1 ORDER BY aggregate_version',
            [id],
          )
        ).rows,
      });
      const assertSingle = (results, errorCode) => {
        assert.equal(
          results.filter((result) => result.status === 'fulfilled').length,
          1,
        );
        assert.equal(
          results.find((result) => result.status === 'rejected').reason.code,
          errorCode,
        );
      };
      const first = await createOrder(true);
      await assert.rejects(service.closeProduction(first.id, {}, inspector), {
        code: 'explicitConfirmationRequired',
      });
      await assert.rejects(
        service.closeProduction(first.id, confirmed, worker),
        { code: 'SERVICE_ORDER_FORBIDDEN' },
      );
      await assert.rejects(
        service.closeProduction(first.id, confirmed, {
          id: ids.outsider,
          type: 'user',
        }),
        { code: 'sectorGrantRequired' },
      );
      await assert.rejects(
        service.closeProduction(first.id, confirmed, inspector),
        { code: 'productionQualityPrerequisiteRequired' },
      );
      await assert.rejects(
        service.complete(
          first.id,
          { ...confirmed, fulfillment: 'DELIVERY' },
          worker,
        ),
        { code: 'completionNotAllowed' },
      );
      await service.inspectQuality(
        { qualityId: first.qualities[1], quantity: 1, outcome: 'APPROVED' },
        inspector,
      );
      assert.equal(
        (await state(first.id)).order[0].functional_status,
        'IN_PRODUCTION',
      );
      assert.equal(
        (await state(first.id)).order[0].production_completed,
        false,
      );
      const qualityBefore = (
        await db.query(
          'SELECT * FROM service_order_qualities WHERE service_order_id=$1 ORDER BY id',
          [first.id],
        )
      ).rows;
      for (const failure of ['event', 'outbox']) {
        const prior = await state(first.id);
        const target =
          failure === 'event' ? service.events : ServiceOrderOutbox;
        const method = failure === 'event' ? 'append' : 'create';
        const original = target[method];
        target[method] = async () => {
          throw new Error(`RF21-22 ${failure} failure`);
        };
        try {
          await assert.rejects(
            service.closeProduction(first.id, confirmed, inspector),
            /RF21-22 .* failure/,
          );
        } finally {
          target[method] = original;
        }
        assert.deepEqual(await state(first.id), prior);
      }
      assertSingle(
        await Promise.allSettled(
          [1, 2].map(() =>
            service.closeProduction(first.id, confirmed, inspector),
          ),
        ),
        'productionClosureNotAllowed',
      );
      let current = await state(first.id);
      assert.equal(current.order[0].functional_status, 'AWAITING_DELIVERY');
      assert.equal(current.responsibilities[0].released_at, null);
      await assert.rejects(
        service.complete(
          first.id,
          { ...confirmed, fulfillment: 'DELIVERY' },
          inspector,
        ),
        { code: 'SERVICE_ORDER_FORBIDDEN' },
      );
      await assert.rejects(
        service.complete(
          first.id,
          { ...confirmed, fulfillment: 'BOTH' },
          worker,
        ),
        { code: 'fulfillmentConfirmationInvalid' },
      );
      for (const failure of ['event', 'outbox']) {
        const prior = await state(first.id);
        const target =
          failure === 'event' ? service.events : ServiceOrderOutbox;
        const method = failure === 'event' ? 'append' : 'create';
        const original = target[method];
        target[method] = async () => {
          throw new Error(`RF21-22 ${failure} failure`);
        };
        try {
          await assert.rejects(
            service.complete(
              first.id,
              { ...confirmed, fulfillment: 'DELIVERY' },
              worker,
            ),
            /RF21-22 .* failure/,
          );
        } finally {
          target[method] = original;
        }
        assert.deepEqual(await state(first.id), prior);
      }
      assertSingle(
        await Promise.allSettled(
          [1, 2].map(() =>
            service.complete(
              first.id,
              { ...confirmed, fulfillment: 'DELIVERY' },
              worker,
            ),
          ),
        ),
        'completionNotAllowed',
      );
      current = await state(first.id);
      assert.equal(current.order[0].functional_status, 'COMPLETED');
      assert.equal(current.order[0].administrative_state, 'CLOSED');
      assert.equal(current.responsibilities.length, 1);
      assert.equal(current.responsibilities[0].released_by, worker.id);
      assert.ok(current.responsibilities[0].released_at);
      assert.equal(
        current.events.filter(
          (event) => event.event_type === 'ServiceOrderCompletionConfirmed',
        ).length,
        1,
      );
      assert.equal(
        current.events.filter(
          (event) =>
            event.event_type === 'ServiceOrderProductionClosureConfirmed',
        ).length,
        1,
      );
      assert.equal(current.events.length, current.outbox.length);
      for (const event of current.events) {
        assert.equal(
          current.outbox.filter((row) => row.event_id === event.event_id)
            .length,
          1,
        );
        assert.ok(event.actor_user_id);
        assert.ok(event.occurred_at);
      }
      await assert.rejects(service.reopen(first.id, {}, admin), {
        code: 'operationNotSupported',
      });
      await assert.rejects(service.resume(first.id, admin), {
        code: 'operationNotSupported',
      });
      await assert.rejects(service.cancel(first.id, {}, admin), {
        code: 'orderTerminal',
      });
      await assert.rejects(
        service.transitionFunctionalStatus(first.id, 'IN_PRODUCTION', admin),
        { code: 'functionalStatusTransitionInvalid' },
      );
      await assert.rejects(
        service.inspectQuality(
          { qualityId: first.qualities[0], quantity: 1, outcome: 'APPROVED' },
          inspector,
        ),
        { code: 'orderNotActive' },
      );
      assert.deepEqual(
        (
          await db.query(
            'SELECT * FROM service_order_qualities WHERE service_order_id=$1 ORDER BY id',
            [first.id],
          )
        ).rows,
        qualityBefore,
      );
      const projection = new ServiceOrderProjectionService();
      let projected = {
        products: first.products.map((itemId) => ({ itemId, quantity: 1 })),
        status: 'IN_PRODUCTION',
        administrativeState: 'ACTIVE',
        responsibleUserId: ids.worker,
      };
      for (const event of current.events)
        projected = projection.reduce(projected, {
          eventType: event.event_type,
          occurredAt: event.occurred_at,
          aggregateVersion: event.aggregate_version,
          productItemId: event.product_item_id,
          payload: event.payload,
        });
      assert.equal(projected.status, 'COMPLETED');
      assert.equal(projected.responsibleUserId, null);
      assert.equal(projected.completion.fulfillment, 'DELIVERY');
      const second = await createOrder(false);
      await service.closeProduction(second.id, confirmed, admin);
      await service.complete(
        second.id,
        { ...confirmed, fulfillment: 'INSTALLATION' },
        admin,
      );
      assert.equal(
        (await state(second.id)).order[0].functional_status,
        'COMPLETED',
      );
      assert.equal(
        (await state(second.id)).responsibilities[0].released_by,
        admin.id,
      );
      const after = await snapshot();
      for (const [table, rows] of Object.entries(before)) {
        const key =
          table === 'service_order_events' || table === 'service_order_outbox'
            ? 'event_id'
            : 'id';
        const byId = new Map(after[table].map((row) => [row[key], row]));
        for (const row of rows)
          assert.deepEqual(
            byId.get(row[key]),
            row,
            `Historical row changed in ${table}`,
          );
      }
      assert.equal(
        after.service_orders.length - before.service_orders.length,
        2,
      );
    } finally {
      await db.end();
      await Database.connection.close();
    }
  },
);
