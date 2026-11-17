import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { serviceOrderService } from '../../../src/app/services/ServiceOrderService.js';
import { ServiceOrderProjectionService } from '../../../src/app/services/ServiceOrderProjectionService.js';

const enabled =
  process.env.RUN_POSTGRES_SERVICE_ORDER_RECOVERY_INTEGRATION === '1';

test(
  'Feature 004 quality partial inspection, selective reinspection, FIFO sector isolation and rollback',
  { skip: !enabled },
  async () => {
    assert.equal(process.env.DB_HOST, 'feature004-recovery-20261113-postgres');
    const db = new pg.Client({
      host: process.env.DB_HOST,
      port: 5432,
      database: process.env.DB_DATABASE,
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
    });
    await db.connect();
    const key = randomUUID();
    const ids = Object.fromEntries(
      [
        'sector',
        'otherSector',
        'client',
        'admin',
        'worker',
        'inspector',
        'otherInspector',
        'worker2',
        'worker3',
      ].map((name) => [name, randomUUID()]),
    );
    const timestamp = new Date();
    const createdOrders = [];
    const worker = { id: ids.worker, type: 'user', role: 'user' };
    const admin = { id: ids.admin, type: 'user', role: 'admin' };
    try {
      const baseline = await db.query(
        "SELECT count(*)::int n FROM service_orders WHERE external_number NOT LIKE 'RF12-24-%'",
      );
      const baselineOrderCount = baseline.rows[0].n;
      await db.query(
        'INSERT INTO sectors(id,code,name,created_at,updated_at) VALUES($1,$2,$3,$4,$4),($5,$6,$7,$4,$4)',
        [
          ids.sector,
          `Q${key.slice(0, 20)}`,
          `RF12-24 quality ${key}`,
          timestamp,
          ids.otherSector,
          `T${key.slice(0, 20)}`,
          `RF12-24 other ${key}`,
        ],
      );
      await db.query(
        "INSERT INTO client(id,name,email,phone,client_status,cep,rua,number_house,bairro,cidade,uf,created_at,updated_at) VALUES($1,$2,$3,'555','active','00000','test','1','test','test','SP',$4,$4)",
        [
          ids.client,
          `RF12-24 quality ${key}`,
          `${key}@quality-client.test`,
          timestamp,
        ],
      );
      for (const userId of Object.values(ids).filter(
        (id) => ![ids.sector, ids.otherSector, ids.client].includes(id),
      )) {
        await db.query(
          "INSERT INTO users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at) VALUES($1,$2,$3,'test-only','user','active','',$4,$4)",
          [
            userId,
            `RF12-24 user ${userId}`,
            `${userId}@quality.test`,
            timestamp,
          ],
        );
      }
      for (const sectorId of [ids.sector, ids.otherSector])
        for (const userId of [
          ids.worker,
          ids.inspector,
          ids.otherInspector,
          ids.worker2,
          ids.worker3,
        ])
          await db.query(
            'INSERT INTO user_sectors(user_id,sector_id,granted_by,created_at) VALUES($1,$2,$3,$4)',
            [userId, sectorId, ids.admin, timestamp],
          );

      for (const [userId, sectorId] of [
        [ids.worker, ids.sector],
        [ids.inspector, ids.sector],
        [ids.otherInspector, ids.otherSector],
      ]) {
        await serviceOrderService.configurePermission(
          {
            userId,
            sectorId,
            operation: 'RECORD_QUALITY',
            reason: `RF12-24 quality authorization ${key}`,
          },
          admin,
        );
      }
      const createOrder = async (
        label,
        sectorId = ids.sector,
        quantity = 4,
      ) => {
        const id = randomUUID();
        const external = `RF12-24-${key.slice(0, 8)}-${label}`;
        await db.query(
          "INSERT INTO service_orders(id,external_number,client_id,sector_id,due_at,public_status,administrative_state,operational_version,queue_entered_at,production_completed,created_by,functional_status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'APPROVED','ACTIVE',0,$5,false,$6,'IN_PRODUCTION',$5,$5)",
          [id, external, ids.client, sectorId, timestamp, ids.admin],
        );
        const productId = randomUUID();
        await db.query(
          "INSERT INTO service_order_products(id,service_order_id,name,quantity,unit_code,measurements,specification_revision,completed_quantity,blocked_quantity,created_at,updated_at) VALUES($1,$2,'RF12-24 pane',$4,'UN','{}',1,$4,0,$3,$3)",
          [productId, id, timestamp, quantity],
        );
        const responsibleId =
          sectorId === ids.otherSector
            ? ids.otherInspector
            : label === 'quality-main'
              ? ids.worker
              : label === 'quality-fifo'
                ? ids.worker3
                : ids.worker2;
        await db.query(
          'INSERT INTO service_order_responsibilities(id,service_order_id,user_id,assigned_by,assigned_at) VALUES($1,$2,$3,$4,$5)',
          [randomUUID(), id, responsibleId, ids.admin, timestamp],
        );
        createdOrders.push(id);
        return { id, external, productId };
      };
      const order = await createOrder('quality-main', ids.sector, 10);
      const fifoOrder = await createOrder('quality-fifo', ids.sector, 4);
      const otherSectorOrder = await createOrder(
        'quality-other',
        ids.otherSector,
      );
      await assert.rejects(
        serviceOrderService.signalProductForInspection(
          { orderId: order.id, productId: order.productId, quantity: 4 },
          { id: ids.worker2, type: 'user', role: 'user' },
        ),
        { code: 'responsibilityRequired' },
      );
      const first = await serviceOrderService.signalProductForInspection(
        { orderId: order.id, productId: order.productId, quantity: 10 },
        worker,
      );
      await assert.rejects(
        serviceOrderService.signalProductForInspection(
          { orderId: order.id, productId: order.productId, quantity: 9 },
          worker,
        ),
        { code: 'qualityAlreadyPending' },
      );
      const fifoSignal = await serviceOrderService.signalProductForInspection(
        { orderId: fifoOrder.id, productId: fifoOrder.productId, quantity: 4 },
        { id: ids.worker3, type: 'user' },
      );
      await assert.rejects(
        serviceOrderService.inspectQuality(
          { qualityId: first.id, quantity: 1, outcome: 'REJECTED' },
          { id: ids.inspector, type: 'user' },
        ),
        { code: 'rejectionReasonRequired' },
      );
      const beforeRejected = await db.query(
        'SELECT approved_quantity,rejected_quantity,status FROM service_order_qualities WHERE id=$1',
        [first.id],
      );
      assert.deepEqual(beforeRejected.rows[0], {
        approved_quantity: 0,
        rejected_quantity: 0,
        status: 'OPEN',
      });
      await serviceOrderService.inspectQuality(
        { qualityId: first.id, quantity: 7, outcome: 'APPROVED' },
        { id: ids.inspector, type: 'user' },
      );
      await assert.rejects(
        serviceOrderService.recordExecution(
          { assignmentId: randomUUID(), quantity: 1 },
          worker,
        ),
        { code: 'assignmentNotFound' },
      );
      await serviceOrderService.inspectQuality(
        {
          qualityId: first.id,
          quantity: 3,
          outcome: 'REJECTED',
          reason: 'RF12-24 defeito no acabamento',
        },
        { id: ids.inspector, type: 'user' },
      );
      let result = await db.query(
        'SELECT approved_quantity,rejected_quantity,status,inspection_history FROM service_order_qualities WHERE id=$1',
        [first.id],
      );
      assert.equal(result.rows[0].approved_quantity, 7);
      assert.equal(result.rows[0].rejected_quantity, 3);
      assert.equal(result.rows[0].status, 'REJECTED');
      assert.equal(result.rows[0].inspection_history.length, 2);
      const firstSnapshot = (
        await db.query('SELECT * FROM service_order_qualities WHERE id=$1', [
          first.id,
        ])
      ).rows[0];
      await assert.rejects(
        serviceOrderService.signalProductForInspection(
          { orderId: order.id, productId: order.productId, quantity: 4 },
          worker,
        ),
        { code: 'qualitySignalQuantityInvalid' },
      );
      assert.equal(
        result.rows[0].inspection_history.at(-1).reason,
        'RF12-24 defeito no acabamento',
      );
      const beforeRollback = (
        await db.query(
          'SELECT completed_quantity,blocked_quantity FROM service_order_products WHERE id=$1',
          [order.productId],
        )
      ).rows[0];
      const append = serviceOrderService.events.append;
      serviceOrderService.events.append = async () => {
        throw new Error('quality-event-rollback');
      };
      try {
        await assert.rejects(
          serviceOrderService.signalProductForInspection(
            { orderId: order.id, productId: order.productId, quantity: 3 },
            worker,
          ),
          /quality-event-rollback/,
        );
      } finally {
        serviceOrderService.events.append = append;
      }
      assert.deepEqual(
        (
          await db.query(
            'SELECT completed_quantity,blocked_quantity FROM service_order_products WHERE id=$1',
            [order.productId],
          )
        ).rows[0],
        beforeRollback,
      );
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int n FROM service_order_qualities WHERE product_id=$1',
            [order.productId],
          )
        ).rows[0].n,
        1,
      );
      const signals = await Promise.allSettled(
        [1, 2].map(() =>
          serviceOrderService.signalProductForInspection(
            { orderId: order.id, productId: order.productId, quantity: 3 },
            worker,
          ),
        ),
      );
      assert.equal(
        signals.filter((entry) => entry.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        signals.find((entry) => entry.status === 'rejected').reason.code,
        'qualityAlreadyPending',
      );
      const second = signals.find(
        (entry) => entry.status === 'fulfilled',
      ).value;
      await assert.rejects(
        serviceOrderService.signalProductForInspection(
          { orderId: order.id, productId: order.productId, quantity: 3 },
          worker,
        ),
        { code: 'qualityAlreadyPending' },
      );
      const queue = await serviceOrderService.getQualityQueue(ids.sector, {
        id: ids.inspector,
        type: 'user',
      });
      assert.ok(queue.some((entry) => entry.service_order_id === order.id));
      assert.ok(
        queue.findIndex((entry) => entry.id === fifoSignal.id) <
          queue.findIndex((entry) => entry.id === second.id),
      );
      assert.equal(
        queue.some((entry) => entry.id === first.id),
        false,
      );
      assert.equal(queue.length, 2);
      assert.ok(
        queue.every((entry) => entry.service_order_id !== otherSectorOrder.id),
      );
      const orderQueue = await serviceOrderService.getPendingQualityInspections(
        ids.sector,
        order.external,
        { id: ids.inspector, type: 'user' },
      );
      assert.equal(orderQueue.length, 1);
      const persistedSecond = await db.query(
        'SELECT parent_quality_id FROM service_order_qualities WHERE id=$1',
        [second.id],
      );
      assert.equal(persistedSecond.rows[0].parent_quality_id, first.id);
      await serviceOrderService.inspectQuality(
        {
          qualityId: second.id,
          quantity: 2,
          outcome: 'APPROVED',
        },
        { id: ids.inspector, type: 'user' },
      );
      await assert.rejects(
        serviceOrderService.inspectQuality(
          { qualityId: first.id, quantity: 2, outcome: 'APPROVED' },
          { id: ids.inspector, type: 'user' },
        ),
        { code: 'qualityNotPending' },
      );
      await assert.rejects(
        serviceOrderService.inspectQuality(
          { qualityId: second.id, quantity: 4, outcome: 'APPROVED' },
          { id: ids.inspector, type: 'user' },
        ),
        { code: 'inspectionQuantityInvalid' },
      );
      await serviceOrderService.inspectQuality(
        {
          qualityId: second.id,
          quantity: 1,
          outcome: 'REJECTED',
          reason: 'RF12-24 segunda rejeição',
        },
        { id: ids.inspector, type: 'user' },
      );
      const secondSnapshot = (
        await db.query('SELECT * FROM service_order_qualities WHERE id=$1', [
          second.id,
        ])
      ).rows[0];
      assert.equal(secondSnapshot.approved_quantity, 2);
      assert.equal(secondSnapshot.rejected_quantity, 1);
      assert.equal(secondSnapshot.status, 'REJECTED');
      assert.equal(secondSnapshot.inspection_history.length, 2);
      const third = await serviceOrderService.signalProductForInspection(
        { orderId: order.id, productId: order.productId, quantity: 1 },
        worker,
      );
      const persistedThird = await db.query(
        'SELECT parent_quality_id FROM service_order_qualities WHERE id=$1',
        [third.id],
      );
      assert.equal(persistedThird.rows[0].parent_quality_id, second.id);
      await assert.rejects(
        serviceOrderService.signalProductForInspection(
          { orderId: order.id, productId: order.productId, quantity: 1 },
          worker,
        ),
        { code: 'qualityAlreadyPending' },
      );
      const inspections = await Promise.allSettled(
        [1, 2].map(() =>
          serviceOrderService.inspectQuality(
            { qualityId: third.id, quantity: 1, outcome: 'APPROVED' },
            { id: ids.inspector, type: 'user' },
          ),
        ),
      );
      assert.equal(
        inspections.filter((entry) => entry.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        inspections.find((entry) => entry.status === 'rejected').reason.code,
        'qualityNotPending',
      );
      for (const [id, snapshot] of [
        [first.id, firstSnapshot],
        [second.id, secondSnapshot],
      ]) {
        assert.deepEqual(
          (
            await db.query(
              'SELECT * FROM service_order_qualities WHERE id=$1',
              [id],
            )
          ).rows[0],
          snapshot,
        );
        await assert.rejects(
          serviceOrderService.inspectQuality(
            { qualityId: id, quantity: 1, outcome: 'APPROVED' },
            { id: ids.inspector, type: 'user' },
          ),
          { code: 'qualityNotPending' },
        );
      }
      await assert.rejects(
        serviceOrderService.signalProductForInspection(
          { orderId: order.id, productId: order.productId, quantity: 1 },
          worker,
        ),
        { code: 'qualitySignalQuantityInvalid' },
      );
      result = await db.query(
        'SELECT approved_quantity,rejected_quantity FROM service_order_qualities WHERE id=$1',
        [first.id],
      );
      assert.equal(result.rows[0].approved_quantity, 7);
      assert.equal(result.rows[0].rejected_quantity, 3);
      const finalTotals = await db.query(
        'SELECT sum(approved_quantity)::int approved,sum(rejected_quantity)::int rejected FROM service_order_qualities WHERE product_id=$1',
        [order.productId],
      );
      assert.deepEqual(finalTotals.rows[0], { approved: 10, rejected: 4 });
      // Rejections are historical attempts, not an outstanding balance.
      const eventRows = await db.query(
        'SELECT * FROM service_order_events WHERE aggregate_id=$1 ORDER BY aggregate_version',
        [order.id],
      );
      const projection = new ServiceOrderProjectionService();
      let projected = {
        administrativeState: 'ACTIVE',
        publicStatus: 'IN_PRODUCTION',
        productionCompleted: false,
        products: [
          {
            itemId: order.productId,
            quantity: 10,
            completedQuantity: 10,
            blockedQuantity: 0,
            status: 'IN_PRODUCTION',
          },
        ],
      };
      for (const event of eventRows.rows)
        projected = projection.reduce(projected, {
          eventType: event.event_type,
          productItemId: event.product_item_id,
          occurredAt: event.occurred_at,
          payload: event.payload,
        });
      assert.equal(projected.products[0].qualityApprovedQuantity, 10);
      assert.equal(projected.products[0].status, 'PRODUCTION_COMPLETED');
      assert.equal(projected.products[0].completedQuantity, 10);
      assert.equal(projected.products[0].blockedQuantity, 0);
      assert.equal(projected.productionCompleted, false);
      assert.deepEqual(
        (
          await db.query(
            'SELECT administrative_state,production_completed FROM service_orders WHERE id=$1',
            [order.id],
          )
        ).rows[0],
        { administrative_state: 'ACTIVE', production_completed: false },
      );
      assert.equal(
        (
          await db.query(
            'SELECT completed_quantity FROM service_order_products WHERE id=$1',
            [order.productId],
          )
        ).rows[0].completed_quantity,
        10,
      );
      const after = await db.query(
        "SELECT count(*)::int n FROM service_orders WHERE external_number NOT LIKE 'RF12-24-%'",
      );
      assert.equal(after.rows[0].n, baselineOrderCount);
      const fixtureQuality = await db.query(
        "SELECT count(*)::int n FROM service_order_qualities WHERE service_order_id = ANY($1::uuid[]) AND issue LIKE 'Sinalizado para conferência%'",
        [createdOrders],
      );
      assert.ok(fixtureQuality.rows[0].n >= 2);
    } finally {
      await db.end();
    }
  },
);
