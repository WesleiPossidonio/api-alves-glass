import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import Database from '../../../src/database/index.js';
import { serviceOrderService as service } from '../../../src/app/services/ServiceOrderService.js';
import ServiceOrderOutbox from '../../../src/app/models/ServiceOrderOutbox.js';
import { ServiceOrderProjectionService } from '../../../src/app/services/ServiceOrderProjectionService.js';

test(
  'RF07/09/10/11 product validation, direct correction, immutable quantity, per-product quality lock, audit and concurrency',
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
        'other',
        'client',
        'admin',
        'creator',
        'manager',
        'member',
        'foreign',
        'order',
        'product',
        'sibling',
      ].map((name) => [name, randomUUID()]),
    );
    const actor = (name) => ({
      id: ids[name],
      type: 'user',
      role: name === 'admin' ? 'admin' : 'user',
    });
    const now = new Date();
    const snapshot = async () => {
      const result = {};
      for (const table of [
        'service_orders',
        'service_order_products',
        'service_order_qualities',
        'service_order_events',
        'service_order_outbox',
      ])
        result[table] = (
          await db.query(`SELECT to_jsonb(t) value FROM ${table} t`)
        ).rows.map(({ value }) => value);
      return result;
    };
    try {
      assert.deepEqual(
        (await db.query('SELECT current_database() db,current_user usr'))
          .rows[0],
        {
          db: 'feature004_recovery_integration',
          usr: 'feature004_recovery_dev',
        },
      );
      const metadata = await db.query(
        'SELECT name FROM "SequelizeMeta" WHERE name = ANY($1::text[])',
        [
          [
            '20261125000000-link-quality-reinspections.cjs',
            '20261126000000-add-service-order-informational-priority.cjs',
          ],
        ],
      );
      assert.ok(
        metadata.rows.some(
          (row) =>
            row.name ===
            '20261126000000-add-service-order-informational-priority.cjs',
        ),
        'Recovery priority migration must already be recorded; do not apply migrations',
      );
      assert.equal(
        metadata.rowCount,
        2,
        'Required recovery migrations must already be recorded',
      );
      const before = await snapshot();
      await Database.connection.transaction(async (transaction) => {
        const query = (sql, bind) =>
          Database.connection.query(sql, { bind, transaction });
        for (const sector of [ids.sector, ids.other])
          await query(
            'INSERT INTO sectors(id,code,name,created_at,updated_at) VALUES($1,$2,$3,$4,$4)',
            [sector, `C${sector.slice(0, 20)}`, `RF09 ${sector}`, now],
          );
        await query(
          "INSERT INTO client(id,name,email,phone,client_status,cep,rua,number_house,bairro,cidade,uf,created_at,updated_at) VALUES($1,$2,$2,'555','active','00000','test','1','test','test','SP',$3,$3)",
          [ids.client, `${ids.client}@correction.test`, now],
        );
        for (const name of [
          'admin',
          'creator',
          'manager',
          'member',
          'foreign',
        ]) {
          await query(
            "INSERT INTO users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at) VALUES($1,$2,$2,'test-only','user','active','',$3,$3)",
            [ids[name], `${ids[name]}@correction.test`, now],
          );
          await query(
            'INSERT INTO user_sectors(user_id,sector_id,granted_by,created_at) VALUES($1,$2,$3,$4)',
            [
              ids[name],
              name === 'foreign' ? ids.other : ids.sector,
              ids.admin,
              now,
            ],
          );
        }
        for (const [name, sectorId, operation] of [
          ['creator', ids.sector, 'CREATE'],
          ['manager', ids.sector, 'MANAGE_RESPONSIBILITY'],
          ['foreign', ids.other, 'MANAGE_RESPONSIBILITY'],
        ])
          await service.permissions.grant(
            {
              userId: ids[name],
              sectorId,
              operation,
              actorId: ids.admin,
              reason: 'RF09 integration',
            },
            { transaction },
          );
        await query(
          "INSERT INTO service_orders(id,external_number,client_id,sector_id,due_at,public_status,administrative_state,operational_version,queue_entered_at,production_completed,created_by,functional_status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'IN_PRODUCTION','ACTIVE',0,$5,false,$6,'IN_PRODUCTION',$5,$5)",
          [
            ids.order,
            `RF09-${ids.order}`,
            ids.client,
            ids.sector,
            now,
            ids.creator,
          ],
        );
        for (const id of [ids.product, ids.sibling])
          await query(
            "INSERT INTO service_order_products(id,service_order_id,name,quantity,unit_code,measurements,specification_revision,completed_quantity,blocked_quantity,created_at,updated_at) VALUES($1,$2,'RF09 panel',2,'UN',$3,1,0,0,$4,$4)",
            [
              id,
              ids.order,
              JSON.stringify({
                widthMm: '100',
                heightMm: '200',
                finish: 'polished',
              }),
              now,
            ],
          );
      });
      const state = async () => ({
        order: (
          await db.query('SELECT * FROM service_orders WHERE id=$1', [
            ids.order,
          ])
        ).rows,
        products: (
          await db.query(
            'SELECT * FROM service_order_products WHERE service_order_id=$1 ORDER BY id',
            [ids.order],
          )
        ).rows,
        events: (
          await db.query(
            'SELECT * FROM service_order_events WHERE aggregate_id=$1 ORDER BY aggregate_version',
            [ids.order],
          )
        ).rows,
        outbox: (
          await db.query(
            'SELECT * FROM service_order_outbox WHERE aggregate_id=$1 ORDER BY aggregate_version',
            [ids.order],
          )
        ).rows,
      });
      const version = async () =>
        String((await state()).order[0].operational_version);
      const correct = (input, name = 'creator') =>
        service.correctProduct(ids.order, ids.product, input, actor(name));
      const initial = await state();
      for (const name of ['member', 'foreign'])
        await assert.rejects(
          correct({ expectedVersion: '0', name: 'Denied' }, name),
          {
            code:
              name === 'foreign'
                ? 'sectorGrantRequired'
                : 'productCorrectionForbidden',
          },
        );
      await assert.rejects(correct({ expectedVersion: '0', products: [] }), {
        code: 'productCorrectionFieldsInvalid',
      });
      await assert.rejects(correct({ expectedVersion: '0', quantity: 1 }), {
        code: 'productQuantityImmutable',
      });
      await assert.rejects(
        correct({ expectedVersion: '0', measurements: { widthMm: 'invalid' } }),
        { code: 'dimensionMustBeValidNumber' },
      );
      for (const measurements of [
        { widthMm: 0 },
        { heightMm: -1 },
        { thicknessMm: 'invalid' },
        { glassColor: '' },
        { aluminumColor: 42 },
        { ironColor: null },
      ])
        await assert.rejects(correct({ expectedVersion: '0', measurements }));
      assert.deepEqual(await state(), initial);
      for (const failure of ['event', 'outbox']) {
        const target =
          failure === 'event' ? service.events : ServiceOrderOutbox;
        const method = failure === 'event' ? 'append' : 'create';
        const original = target[method];
        target[method] = async () => {
          throw new Error('RF09 injected failure');
        };
        try {
          await assert.rejects(
            correct({ expectedVersion: '0', name: 'Rollback' }),
            /RF09 injected failure/,
          );
        } finally {
          target[method] = original;
        }
        assert.deepEqual(await state(), initial);
      }
      await correct({
        expectedVersion: '0',
        measurements: {
          widthMm: '101.25',
          thicknessMm: '06.00',
          glassColor: 'Cor livre',
          aluminumColor: 'Grafite personalizado',
        },
      });
      const results = await Promise.allSettled(
        ['First', 'Second'].map((name) =>
          correct({ expectedVersion: '1', name }, 'manager'),
        ),
      );
      assert.equal(
        results.filter((entry) => entry.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        results.find((entry) => entry.status === 'rejected').reason.code,
        'serviceOrderVersionConflict',
      );
      await correct(
        {
          expectedVersion: await version(),
          description: 'Correction by administrator',
        },
        'admin',
      );
      let current = await state();
      assert.equal(current.products.length, 2);
      assert.deepEqual(
        current.products.find((row) => row.id === ids.sibling),
        initial.products.find((row) => row.id === ids.sibling),
      );
      const corrected = current.products.find((row) => row.id === ids.product);
      assert.equal(corrected.quantity, 2);
      assert.equal(corrected.specification_revision, 1);
      assert.deepEqual(corrected.measurements, {
        widthMm: '101.25',
        heightMm: '200',
        finish: 'polished',
        thicknessMm: '06.00',
        glassColor: 'Cor livre',
        aluminumColor: 'Grafite personalizado',
      });
      assert.equal(current.events.length, 3);
      assert.equal(current.outbox.length, 3);
      assert.equal(
        current.events[0].payload.previousValues.measurements.widthMm,
        '100',
      );
      assert.equal(
        current.events[0].payload.newValues.measurements.widthMm,
        '101.25',
      );
      for (const event of current.events) {
        assert.equal(event.event_type, 'ServiceOrderProductCorrected');
        assert.ok(event.occurred_at);
        assert.ok(event.actor_user_id);
        assert.equal(
          current.outbox.filter((row) => row.event_id === event.event_id)
            .length,
          1,
        );
      }
      const projection = new ServiceOrderProjectionService();
      let projected = {
        products: [
          {
            itemId: ids.product,
            quantity: 2,
            measurements: { widthMm: '100', heightMm: '200' },
          },
        ],
      };
      for (const event of current.events)
        projected = projection.reduce(projected, {
          eventType: event.event_type,
          productItemId: event.product_item_id,
          occurredAt: event.occurred_at,
          payload: event.payload,
        });
      assert.deepEqual(
        projected.products[0].measurements,
        corrected.measurements,
      );
      assert.equal(projected.products[0].name, corrected.name);
      // State-limit checks run in an isolated transaction with nested savepoints;
      // fixtures are rolled back without altering the committed OS history.
      const connection = service.database;
      const isolatedService = new service.constructor({
        database: null,
        orders: service.orders,
        quality: service.quality,
        events: service.events,
        permissions: service.permissions,
      });
      const stop = new Error('RF09 rollback-only probes');
      await assert.rejects(
        Database.connection.transaction(async (outer) => {
          isolatedService.database = {
            connection: {
              transaction: (fn) =>
                Database.connection.transaction({ transaction: outer }, fn),
            },
          };
          // Registration probes share the rollback-only outer transaction.
          const registrationProducts = [
            {
              name: 'Vidro sem opcionais',
              quantity: 1,
              measurements: { width: '001.2500', height: 2 },
            },
            {
              name: 'Ferro com opcionais',
              quantity: 2,
              measurements: {
                widthMm: '100',
                heightMm: '200',
                thicknessMm: '06.00',
                glassColor: 'Cristal livre',
                ironColor: 'Grafite',
                profile: { riseMm: '42.75' },
              },
            },
          ];
          const registered = await isolatedService.register(
            {
              clientId: ids.client,
              sectorId: ids.sector,
              externalNumber: `RF07-${randomUUID()}`,
              dueAt: now.toISOString(),
              products: registrationProducts,
            },
            actor('creator'),
          );
          const [registeredProducts] = await Database.connection.query(
            'SELECT * FROM service_order_products WHERE service_order_id=$1',
            { bind: [registered.id], transaction: outer },
          );
          assert.equal(registeredProducts.length, 2);
          for (const input of registrationProducts) {
            const persisted = registeredProducts.find(
              (row) => row.name === input.name,
            );
            assert.deepEqual(persisted.measurements, input.measurements);
            assert.equal(persisted.quantity, input.quantity);
          }
          const [registeredEvents] = await Database.connection.query(
            'SELECT * FROM service_order_events WHERE aggregate_id=$1',
            { bind: [registered.id], transaction: outer },
          );
          const [registeredOutbox] = await Database.connection.query(
            'SELECT * FROM service_order_outbox WHERE aggregate_id=$1',
            { bind: [registered.id], transaction: outer },
          );
          assert.equal(registeredEvents.length, 3);
          assert.equal(registeredOutbox.length, 3);
          for (const event of registeredEvents)
            assert.equal(
              registeredOutbox.filter((row) => row.event_id === event.event_id)
                .length,
              1,
            );
          for (const status of [
            'REGISTERED',
            'AWAITING_SUPPLIER',
            'AWAITING_DELIVERY',
            'COMPLETED',
            'CANCELLED',
          ]) {
            await Database.connection.query(
              'UPDATE service_orders SET functional_status=$1 WHERE id=$2',
              { bind: [status, ids.order], transaction: outer },
            );
            await assert.rejects(
              isolatedService.correctProduct(
                ids.order,
                ids.product,
                { expectedVersion: '3', description: 'Denied' },
                actor('admin'),
              ),
              { code: 'productCorrectionNotAllowed' },
            );
            for (const quantity of [1, 3])
              await assert.rejects(
                isolatedService.correctProduct(
                  ids.order,
                  ids.product,
                  { expectedVersion: '3', quantity },
                  actor('admin'),
                ),
                { code: 'productCorrectionNotAllowed' },
              );
          }
          await Database.connection.query(
            "UPDATE service_orders SET functional_status='IN_PRODUCTION' WHERE id=$1",
            { bind: [ids.order], transaction: outer },
          );
          for (const quantity of [1, 3])
            await assert.rejects(
              isolatedService.correctProduct(
                ids.order,
                ids.product,
                { expectedVersion: '3', quantity },
                actor('admin'),
              ),
              { code: 'productQuantityImmutable' },
            );
          const qualityId = randomUUID();
          await Database.connection.query(
            "INSERT INTO service_order_qualities(id,service_order_id,product_id,reported_by,issue,affected_quantity,approved_quantity,rejected_quantity,status,created_at,inspection_history) VALUES($1,$2,$3,$4,'RF11 first signal probe',2,0,0,'OPEN',$5,'[]')",
            {
              bind: [qualityId, ids.order, ids.product, ids.creator, now],
              transaction: outer,
            },
          );
          // First signal is enough: no inspection or approved units required.
          for (const status of ['OPEN', 'APPROVED', 'REJECTED']) {
            await Database.connection.query(
              'UPDATE service_order_qualities SET status=$1 WHERE id=$2',
              { bind: [status, qualityId], transaction: outer },
            );
            for (const change of [
              { name: 'Denied' },
              { description: 'Denied' },
              { measurements: { widthMm: '500' } },
            ])
              await assert.rejects(
                isolatedService.correctProduct(
                  ids.order,
                  ids.product,
                  { expectedVersion: '3', ...change },
                  actor('admin'),
                ),
                { code: 'productCorrectionQualityConflict' },
              );
          }
          const siblingCorrection = await isolatedService.correctProduct(
            ids.order,
            ids.sibling,
            {
              expectedVersion: '3',
              quantity: 2,
              description: 'Independent product correction',
            },
            actor('admin'),
          );
          assert.deepEqual(siblingCorrection.newValues, {
            description: 'Independent product correction',
          });
          const [probeEvents] = await Database.connection.query(
            'SELECT * FROM service_order_events WHERE aggregate_id=$1 AND aggregate_version=4',
            { bind: [ids.order], transaction: outer },
          );
          const [probeOutbox] = await Database.connection.query(
            'SELECT * FROM service_order_outbox WHERE aggregate_id=$1 AND aggregate_version=4',
            { bind: [ids.order], transaction: outer },
          );
          assert.equal(probeEvents.length, 1);
          assert.equal(probeOutbox.length, 1);
          assert.equal(probeEvents[0].product_item_id, ids.sibling);
          assert.equal(probeOutbox[0].event_id, probeEvents[0].event_id);
          assert.equal(probeEvents[0].payload.correctedBy, ids.admin);
          assert.equal(probeEvents[0].payload.previousValues.description, null);
          assert.ok(probeEvents[0].payload.correctedAt);
          await assert.rejects(
            isolatedService.correctProduct(
              ids.order,
              ids.product,
              { expectedVersion: '4', measurements: { widthMm: '500' } },
              actor('admin'),
            ),
            { code: 'productCorrectionQualityConflict' },
          );
          throw stop;
        }),
        (error) => {
          if (error !== stop) throw error;
          return true;
        },
      );
      assert.strictEqual(service.database, connection);
      assert.deepEqual(await state(), current);
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
        1,
      );
    } finally {
      await db.end();
      await Database.connection.close();
    }
  },
);
