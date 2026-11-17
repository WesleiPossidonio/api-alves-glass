import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import Database from '../../../src/database/index.js';
import { serviceOrderService as service } from '../../../src/app/services/ServiceOrderService.js';
import ServiceOrderOutbox from '../../../src/app/models/ServiceOrderOutbox.js';
import { ServiceOrderProjectionService } from '../../../src/app/services/ServiceOrderProjectionService.js';

test(
  'RF-30 informational priority, sector authorization, outbox rollback, replay and unchanged FIFO',
  {
    skip: process.env.RUN_POSTGRES_SERVICE_ORDER_RECOVERY_INTEGRATION !== '1',
  },
  async () => {
    assert.equal(process.env.DB_HOST, 'feature004-recovery-20261113-postgres');
    assert.equal(process.env.DB_DATABASE, 'feature004_recovery_integration');
    assert.equal(process.env.DB_USERNAME, 'feature004_recovery_dev');
    const db = new pg.Client({
      host: process.env.DB_HOST,
      port: 5432,
      database: process.env.DB_DATABASE,
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
    });
    await db.connect();
    const ids = Object.fromEntries(
      [
        'sector',
        'otherSector',
        'client',
        'admin',
        'manager',
        'member',
        'foreignManager',
        'early',
        'late',
        'otherOrder',
      ].map((name) => [name, randomUUID()]),
    );
    const manager = { id: ids.manager, type: 'user' };
    const admin = { id: ids.admin, type: 'user', role: 'admin' };
    const now = new Date();
    const snapshot = async () => {
      const result = {};
      for (const table of [
        'service_orders',
        'service_order_qualities',
        'service_order_events',
        'service_order_outbox',
      ]) {
        result[table] = (
          await db.query(`SELECT to_jsonb(t) value FROM ${table} t`)
        ).rows.map(({ value }) => value);
      }
      return result;
    };
    try {
      const identity = (
        await db.query('SELECT current_database() db,current_user usr')
      ).rows[0];
      assert.equal(identity.db, 'feature004_recovery_integration');
      assert.equal(identity.usr, 'feature004_recovery_dev');
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int n FROM "SequelizeMeta" WHERE name=$1',
            ['20261126000000-add-service-order-informational-priority.cjs'],
          )
        ).rows[0].n,
        1,
      );
      const before = await snapshot();
      // One atomic setup; only three OS are required for chronological and sector isolation checks.
      await Database.connection.transaction(async (transaction) => {
        const query = (sql, bind) =>
          Database.connection.query(sql, { bind, transaction });
        for (const sector of [ids.sector, ids.otherSector])
          await query(
            'INSERT INTO sectors(id,code,name,created_at,updated_at) VALUES($1,$2,$3,$4,$4)',
            [sector, `P${sector.slice(0, 20)}`, `RF30 ${sector}`, now],
          );
        await query(
          "INSERT INTO client(id,name,email,phone,client_status,cep,rua,number_house,bairro,cidade,uf,created_at,updated_at) VALUES($1,$2,$2,'555','active','00000','test','1','test','test','SP',$3,$3)",
          [ids.client, `${ids.client}@priority.test`, now],
        );
        for (const name of ['admin', 'manager', 'member', 'foreignManager']) {
          await query(
            "INSERT INTO users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at) VALUES($1,$2,$2,'test-only','user','active','',$3,$3)",
            [ids[name], `${ids[name]}@priority.test`, now],
          );
          await query(
            'INSERT INTO user_sectors(user_id,sector_id,granted_by,created_at) VALUES($1,$2,$3,$4)',
            [
              ids[name],
              name === 'foreignManager' ? ids.otherSector : ids.sector,
              ids.admin,
              now,
            ],
          );
        }
        for (const [userId, sectorId, operations] of [
          [
            ids.manager,
            ids.sector,
            ['MANAGE_RESPONSIBILITY', 'READ_INTERNAL', 'RECORD_QUALITY'],
          ],
          [ids.foreignManager, ids.otherSector, ['MANAGE_RESPONSIBILITY']],
        ])
          for (const operation of operations)
            await service.permissions.grant(
              {
                userId,
                sectorId,
                operation,
                actorId: ids.admin,
                reason: 'RF30 integration',
              },
              { transaction },
            );
        for (const [id, sector, date] of [
          [ids.early, ids.sector, new Date(now.getTime() - 1000)],
          [ids.late, ids.sector, now],
          [ids.otherOrder, ids.otherSector, now],
        ]) {
          await query(
            "INSERT INTO service_orders(id,external_number,client_id,sector_id,due_at,public_status,administrative_state,operational_version,queue_entered_at,production_completed,created_by,functional_status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'IN_PRODUCTION','ACTIVE',0,$5,false,$6,'IN_PRODUCTION',$5,$5)",
            [id, `RF30-${id}`, ids.client, sector, date, ids.admin],
          );
          const product = randomUUID();
          await query(
            "INSERT INTO service_order_products(id,service_order_id,name,quantity,unit_code,measurements,specification_revision,completed_quantity,blocked_quantity,created_at,updated_at) VALUES($1,$2,'RF30',1,'UN','{}',1,1,0,$3,$3)",
            [product, id, date],
          );
          await query(
            "INSERT INTO service_order_qualities(id,service_order_id,product_id,reported_by,issue,affected_quantity,approved_quantity,rejected_quantity,status,created_at,inspection_history) VALUES($1,$2,$3,$4,'RF30 queue fixture',1,0,0,'OPEN',$5,'[]')",
            [randomUUID(), id, product, ids.manager, date],
          );
        }
      });
      const queues = async () => ({
        production: (await service.getQueue(ids.sector, manager)).orders.map(
          (order) => order.id,
        ),
        quality: (await service.getQualityQueue(ids.sector, manager)).map(
          (action) => action.service_order_id,
        ),
      });
      const initial = await queues();
      assert.deepEqual(initial.production, [ids.early, ids.late]);
      assert.deepEqual(initial.quality, [ids.early, ids.late]);
      await assert.rejects(
        service.setPriority(
          ids.late,
          { priority: true },
          { id: ids.member, type: 'user' },
        ),
        { code: 'managerPermissionRequired' },
      );
      await assert.rejects(
        service.setPriority(
          ids.late,
          { priority: true },
          { id: ids.foreignManager, type: 'user' },
        ),
        { code: 'sectorGrantRequired' },
      );
      await assert.rejects(
        service.setPriority(ids.otherOrder, { priority: true }, manager),
        { code: 'sectorGrantRequired' },
      );
      const state = async () => ({
        order: (
          await db.query('SELECT * FROM service_orders WHERE id=$1', [ids.late])
        ).rows,
        events: (
          await db.query(
            'SELECT * FROM service_order_events WHERE aggregate_id=$1 ORDER BY aggregate_version',
            [ids.late],
          )
        ).rows,
        outbox: (
          await db.query(
            'SELECT * FROM service_order_outbox WHERE aggregate_id=$1 ORDER BY aggregate_version',
            [ids.late],
          )
        ).rows,
      });
      for (const failure of ['event', 'outbox']) {
        const prior = await state();
        const target =
          failure === 'event' ? service.events : ServiceOrderOutbox;
        const method = failure === 'event' ? 'append' : 'create';
        const original = target[method];
        target[method] = async () => {
          throw new Error('RF30 injected failure');
        };
        try {
          await assert.rejects(
            service.setPriority(ids.late, { priority: true }, manager),
            /RF30 injected failure/,
          );
        } finally {
          target[method] = original;
        }
        assert.deepEqual(await state(), prior);
      }
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          service.setPriority(ids.late, { priority: true }, manager),
        ),
      );
      assert.equal(
        results.filter((entry) => entry.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        results.find((entry) => entry.status === 'rejected').reason.code,
        'priorityUnchanged',
      );
      assert.deepEqual(await queues(), initial);
      const internal = await service.getInternal(ids.late, manager);
      assert.equal(internal.is_priority, true);
      assert.equal(internal.priority_changed_by, ids.manager);
      assert.ok(internal.priority_changed_at);
      const current = await state();
      assert.equal(current.events.length, 1);
      assert.equal(current.outbox.length, 1);
      assert.equal(current.events[0].event_id, current.outbox[0].event_id);
      assert.equal(current.events[0].actor_user_id, ids.manager);
      assert.equal(current.events[0].payload.previousPriority, false);
      const projection = new ServiceOrderProjectionService();
      let projected = {
        products: [],
        queuedAt: now.toISOString(),
        status: 'IN_PRODUCTION',
      };
      projected = projection.reduce(projected, {
        eventType: current.events[0].event_type,
        payload: current.events[0].payload,
        aggregateVersion: '1',
        occurredAt: current.events[0].occurred_at,
      });
      assert.equal(projected.priority, true);
      assert.equal(projected.priorityChangedBy, ids.manager);
      assert.equal(projected.queuedAt, now.toISOString());
      await service.setPriority(ids.late, { priority: false }, admin);
      const unmarked = await state();
      assert.equal(unmarked.order[0].is_priority, false);
      assert.equal(unmarked.order[0].priority_changed_by, ids.admin);
      assert.equal(unmarked.events.length, 2);
      assert.equal(unmarked.outbox.length, 2);
      assert.equal(unmarked.events[1].payload.previousPriority, true);
      assert.equal(unmarked.events[1].payload.priority, false);
      projected = projection.reduce(projected, {
        eventType: unmarked.events[1].event_type,
        payload: unmarked.events[1].payload,
        aggregateVersion: '2',
        occurredAt: unmarked.events[1].occurred_at,
      });
      assert.equal(projected.priority, false);
      assert.deepEqual(await queues(), initial);
      const after = await snapshot();
      for (const [table, rows] of Object.entries(before)) {
        const key = ['service_order_events', 'service_order_outbox'].includes(
          table,
        )
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
        3,
      );
    } finally {
      await db.end();
      await Database.connection.close();
    }
  },
);
