import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { serviceOrderService } from '../../../src/app/services/ServiceOrderService.js';
import Database from '../../../src/database/index.js';

const enabled =
  process.env.RUN_POSTGRES_SERVICE_ORDER_RECOVERY_INTEGRATION === '1';

test(
  'Feature 004 responsibility and cancellation PostgreSQL recovery concurrency and atomicity',
  { skip: !enabled },
  async () => {
    assert.equal(process.env.DB_HOST, 'feature004-recovery-20261113-postgres');
    assert.equal(process.env.DB_PORT, '5432');
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
    const identity = await db.query(
      'SELECT current_database() db,current_user usr,version() version',
    );
    assert.equal(identity.rows[0].db, 'feature004_recovery_integration');
    assert.equal(identity.rows[0].usr, 'feature004_recovery_dev');
    assert.match(identity.rows[0].version, /PostgreSQL 17/);
    const suffix = randomUUID();
    const ids = {
      sector: randomUUID(),
      client: randomUUID(),
      manager: randomUUID(),
      worker1: randomUUID(),
      worker2: randomUUID(),
      worker3: randomUUID(),
    };
    const madeOrders = [];
    const timestamp = new Date();

    const insertOrder = async (label) => {
      const id = randomUUID();
      const external = `RF12-24-${suffix.slice(0, 8)}-${label}`;
      await db.query(
        `INSERT INTO service_orders(id,external_number,client_id,sector_id,due_at,public_status,administrative_state,operational_version,queue_entered_at,production_completed,created_by,functional_status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'CREATED','ACTIVE',0,$5,false,$6,'REGISTERED',$5,$5)`,
        [id, external, ids.client, ids.sector, timestamp, ids.manager],
      );
      madeOrders.push({ id, external });
      return { id, external };
    };

    try {
      const before = await db.query(
        'SELECT id,external_number,sector_id,created_at FROM service_orders ORDER BY id',
      );
      // The recovery retains historical evidence from every run. Compare the
      // actual baseline below instead of requiring a fixed fixture count.
      const migration = await db.query(
        'SELECT 1 FROM "SequelizeMeta" WHERE name=$1',
        [
          '20261123000000-add-service-order-responsibility-and-functional-status.cjs',
        ],
      );
      assert.equal(migration.rowCount, 1);
      const qualityMigration = await db.query(
        'SELECT 1 FROM "SequelizeMeta" WHERE name=$1',
        ['20261124000000-enable-authorized-quality-self-inspection.cjs'],
      );
      assert.equal(qualityMigration.rowCount, 1);
      await db.query(
        `INSERT INTO sectors(id,code,name,created_at,updated_at) VALUES($1,$2,$3,$4,$4)`,
        [
          ids.sector,
          `R${suffix.replaceAll('-', '').slice(0, 30)}`,
          `RF12-24 ${suffix}`,
          timestamp,
        ],
      );
      await db.query(
        `INSERT INTO client(id,name,email,phone,client_status,cep,rua,number_house,bairro,cidade,uf,created_at,updated_at) VALUES($1,$2,$3,'555','active','00000','test','1','test','test','SP',$4,$4)`,
        [ids.client, `RF12-24 ${suffix}`, `${suffix}@client.test`, timestamp],
      );
      for (const [label, userId] of Object.entries({
        manager: ids.manager,
        worker1: ids.worker1,
        worker2: ids.worker2,
        worker3: ids.worker3,
      })) {
        await db.query(
          `INSERT INTO users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at) VALUES($1,$2,$3,'test-only','user','active','',$4,$4)`,
          [
            userId,
            `RF12-24 ${label} ${suffix}`,
            `${suffix}-${label}@users.test`,
            timestamp,
          ],
        );
        if (label !== 'manager')
          await db.query(
            'INSERT INTO user_sectors(user_id,sector_id,granted_by,created_at) VALUES($1,$2,$3,$4)',
            [userId, ids.sector, ids.manager, timestamp],
          );
      }

      const authorizationOrder = await insertOrder('authorization');
      const grants = [];
      const managerGrants = await serviceOrderService.configurePermission(
        {
          userId: ids.worker3,
          sectorId: ids.sector,
          operation: 'MANAGE_RESPONSIBILITY',
          reason: 'RF12-24 appoint sector manager',
        },
        { id: ids.manager, type: 'user', role: 'admin' },
      );
      grants.push(...managerGrants.map((permission) => permission.grant_id));
      const manager = { id: ids.manager, type: 'user', role: 'admin' };
      const managerActor = { id: ids.worker3, type: 'user', role: 'user' };
      const worker1Actor = { id: ids.worker1, type: 'user', role: 'user' };
      const createdGrant = await serviceOrderService.configurePermission(
        {
          userId: ids.worker2,
          sectorId: ids.sector,
          operation: 'CREATE',
          reason: 'RF12-24 authorized creator',
        },
        managerActor,
      );
      grants.push(createdGrant.grant_id);
      const managerAction = await serviceOrderService
        .releaseResponsibility(authorizationOrder.id, {}, managerActor)
        .catch((error) => error);
      assert.equal(managerAction.code, 'activeResponsibilityNotFound');
      const managedTransfer = await insertOrder('managed-transfer');
      await serviceOrderService.assumeByExternalNumber(
        { sectorId: ids.sector, externalNumber: managedTransfer.external },
        { id: ids.worker1, type: 'user' },
      );
      const transferredByManager =
        await serviceOrderService.releaseResponsibility(
          managedTransfer.id,
          { nextUserId: ids.worker2, reason: 'RF12-24 manager transfer' },
          managerActor,
        );
      assert.equal(transferredByManager.user_id, ids.worker2);
      await serviceOrderService.releaseResponsibility(
        managedTransfer.id,
        {},
        managerActor,
      );
      const managedCancellation = await insertOrder('managed-cancel');
      await serviceOrderService.assumeByExternalNumber(
        { sectorId: ids.sector, externalNumber: managedCancellation.external },
        worker1Actor,
      );
      await serviceOrderService.cancel(
        managedCancellation.id,
        { reason: 'RF12-24 manager cancellation' },
        managerActor,
      );
      await assert.rejects(
        serviceOrderService.configurePermission(
          {
            userId: ids.worker2,
            sectorId: ids.sector,
            operation: 'CANCEL',
            reason: 'must not escalate',
          },
          managerActor,
        ),
        { code: 'managerGrantRestricted' },
      );
      await assert.rejects(
        serviceOrderService.configurePermission(
          {
            userId: ids.worker2,
            sectorId: randomUUID(),
            operation: 'CREATE',
            reason: 'wrong sector',
          },
          managerActor,
        ),
        { code: 'sectorGrantRequired' },
      );

      const revokedManagerGrant = grants[0];
      await serviceOrderService.revokePermission(
        revokedManagerGrant,
        { reason: 'RF12-24 manager revoked' },
        { id: ids.manager, type: 'user', role: 'admin' },
      );
      await assert.rejects(
        serviceOrderService.configurePermission(
          {
            userId: ids.worker2,
            sectorId: ids.sector,
            operation: 'CREATE',
            reason: 'revoked manager',
          },
          managerActor,
        ),
        { code: 'managerPermissionRequired' },
      );

      const creatorPermission = await serviceOrderService.configurePermission(
        {
          userId: ids.worker1,
          sectorId: ids.sector,
          operation: 'CREATE',
          reason: 'RF12-24 admin creator authorization',
        },
        { id: ids.manager, type: 'user', role: 'admin' },
      );
      grants.push(creatorPermission.grant_id);
      const grantRows = await db.query(
        `SELECT g.operation,e.action,e.actor_user_id,e.sector_id
         FROM service_order_operation_grants g
         JOIN service_order_grant_events e ON e.grant_id=g.id
         WHERE g.id=ANY($1::uuid[]) ORDER BY g.operation,e.action`,
        [grants],
      );
      assert.ok(grantRows.rowCount >= 7);
      assert.ok(grantRows.rows.every((row) => row.sector_id === ids.sector));
      assert.ok(grantRows.rows.every((row) => row.actor_user_id));

      const creatorInput = {
        clientId: ids.client,
        sectorId: ids.sector,
        externalNumber: `RF12-24-${suffix.slice(0, 8)}-created-by-worker`,
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        products: [
          {
            name: 'Authorization test item',
            quantity: 1,
            unit: 'UN',
            measurements: { width: '1', height: '1' },
          },
        ],
      };
      const creatorOrder = await serviceOrderService.register(creatorInput, {
        id: ids.worker1,
        type: 'user',
        role: 'user',
      });
      madeOrders.push({
        id: creatorOrder.id,
        external: creatorInput.externalNumber,
      });
      await serviceOrderService.revokePermission(
        creatorPermission.grant_id,
        { reason: 'RF12-24 revoke creator' },
        { id: ids.manager, type: 'user', role: 'admin' },
      );
      await assert.rejects(
        serviceOrderService.register(
          {
            ...creatorInput,
            externalNumber: `${creatorInput.externalNumber}-denied`,
          },
          { id: ids.worker1, type: 'user', role: 'user' },
        ),
        { code: 'SERVICE_ORDER_FORBIDDEN' },
      );
      const otherSectorOrder = await insertOrder('other-sector');
      await assert.rejects(
        serviceOrderService.releaseResponsibility(
          otherSectorOrder.id,
          {},
          managerActor,
        ),
        { code: 'managerPermissionRequired' },
      );

      const sameOrder = await insertOrder('same-order');
      await insertOrder('other-order');
      const [sameResultA, sameResultB] = await Promise.allSettled([
        serviceOrderService.assumeByExternalNumber(
          { sectorId: ids.sector, externalNumber: sameOrder.external },
          { id: ids.worker1, type: 'user' },
        ),
        serviceOrderService.assumeByExternalNumber(
          { sectorId: ids.sector, externalNumber: sameOrder.external },
          { id: ids.worker2, type: 'user' },
        ),
      ]);
      assert.equal(
        [sameResultA, sameResultB].filter((r) => r.status === 'fulfilled')
          .length,
        1,
        JSON.stringify([sameResultA, sameResultB], (_, value) =>
          value instanceof Error
            ? {
                name: value.name,
                message: value.message,
                code: value.code,
                stack: value.stack,
              }
            : value,
        ),
      );
      assert.equal(
        [sameResultA, sameResultB].filter((r) => r.status === 'rejected')
          .length,
        1,
      );
      const sameOwner = (
        await db.query(
          'SELECT user_id FROM service_order_responsibilities WHERE service_order_id=$1 AND released_at IS NULL',
          [sameOrder.id],
        )
      ).rows[0];
      assert.ok([ids.worker1, ids.worker2].includes(sameOwner.user_id));
      await serviceOrderService.releaseResponsibility(
        sameOrder.id,
        {},
        { id: ids.manager, type: 'user', role: 'admin' },
      );

      const [twoA, twoB] = await Promise.all([
        insertOrder('two-a'),
        insertOrder('two-b'),
      ]);
      const [twoResultA, twoResultB] = await Promise.allSettled([
        serviceOrderService.assumeByExternalNumber(
          { sectorId: ids.sector, externalNumber: twoA.external },
          { id: ids.worker3, type: 'user' },
        ),
        serviceOrderService.assumeByExternalNumber(
          { sectorId: ids.sector, externalNumber: twoB.external },
          { id: ids.worker3, type: 'user' },
        ),
      ]);
      assert.equal(
        [twoResultA, twoResultB].filter((r) => r.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        [twoResultA, twoResultB].filter((r) => r.status === 'rejected').length,
        1,
      );
      assert.equal(
        (
          await db.query(
            'SELECT count(*) FROM service_order_responsibilities WHERE user_id=$1 AND released_at IS NULL',
            [ids.worker3],
          )
        ).rows[0].count,
        '1',
      );
      const occupiedOrder = twoResultA.status === 'fulfilled' ? twoA : twoB;
      await serviceOrderService.releaseResponsibility(
        occupiedOrder.id,
        {},
        manager,
      );

      const transferOrder = await insertOrder('transfer');
      await serviceOrderService.assumeByExternalNumber(
        { sectorId: ids.sector, externalNumber: transferOrder.external },
        worker1Actor,
      );

      const transferredResponsibility =
        await serviceOrderService.releaseResponsibility(
          transferOrder.id,
          { nextUserId: ids.worker2, reason: 'RF12-24 transfer' },
          manager,
        );
      const historyAfterTransfer = await db.query(
        'SELECT user_id,assigned_by,released_by,released_at,release_reason FROM service_order_responsibilities WHERE service_order_id=$1 ORDER BY assigned_at,id',
        [transferOrder.id],
      );
      assert.equal(historyAfterTransfer.rowCount, 2);
      assert.equal(historyAfterTransfer.rows[0].user_id, ids.worker1);
      assert.equal(historyAfterTransfer.rows[0].released_by, ids.manager);
      assert.equal(
        historyAfterTransfer.rows[0].release_reason,
        'RF12-24 transfer',
      );
      assert.equal(historyAfterTransfer.rows[1].user_id, ids.worker2);
      await serviceOrderService.releaseResponsibility(
        transferOrder.id,
        { reason: 'RF12-24 release' },
        manager,
      );
      assert.equal(
        (
          await db.query(
            'SELECT count(*) FROM service_order_responsibilities WHERE service_order_id=$1 AND released_at IS NULL',
            [transferOrder.id],
          )
        ).rows[0].count,
        '0',
      );

      for (const reason of ['RF12-24 cancellation reason', null]) {
        const order = await insertOrder(
          reason ? 'cancel-reason' : 'cancel-empty',
        );
        await serviceOrderService.assumeByExternalNumber(
          { sectorId: ids.sector, externalNumber: order.external },
          { id: ids.worker1, type: 'user' },
        );
        await serviceOrderService.cancel(
          order.id,
          reason ? { reason } : {},
          manager,
        );
        const persisted = await db.query(
          `SELECT so.functional_status,so.administrative_state,r.user_id,r.released_by,r.released_at,e.event_type,e.payload event_payload,o.status outbox_status FROM service_orders so JOIN service_order_responsibilities r ON r.service_order_id=so.id JOIN service_order_events e ON e.aggregate_id=so.id AND e.event_type='ServiceOrderCancelled' JOIN service_order_outbox o ON o.event_id=e.event_id WHERE so.id=$1`,
          [order.id],
        );
        assert.equal(persisted.rowCount, 1);
        assert.equal(persisted.rows[0].functional_status, 'CANCELLED');
        assert.equal(persisted.rows[0].administrative_state, 'CANCELLED');
        assert.equal(persisted.rows[0].released_by, ids.manager);
        assert.ok(persisted.rows[0].released_at);
        assert.equal(persisted.rows[0].event_payload.reason, reason);
        assert.equal(persisted.rows[0].outbox_status, 'PENDING');
        await assert.rejects(
          serviceOrderService.cancel(order.id, {}, manager),
          { code: 'orderTerminal' },
        );
      }

      const cancelRollback = await insertOrder('cancel-rollback');
      await serviceOrderService.assumeByExternalNumber(
        { sectorId: ids.sector, externalNumber: cancelRollback.external },
        worker1Actor,
      );
      const cancelEvents = serviceOrderService.events;
      const cancelAppend = cancelEvents.append;
      cancelEvents.append = async () => {
        throw new Error('RF12-24 injected cancellation failure');
      };
      try {
        await assert.rejects(
          serviceOrderService.cancel(cancelRollback.id, {}, manager),
          /injected cancellation failure/,
        );
      } finally {
        cancelEvents.append = cancelAppend;
      }
      assert.equal(
        (
          await db.query(
            'SELECT functional_status,administrative_state FROM service_orders WHERE id=$1',
            [cancelRollback.id],
          )
        ).rows[0].functional_status,
        'REGISTERED',
      );
      assert.equal(
        (
          await db.query(
            'SELECT released_at FROM service_order_responsibilities WHERE service_order_id=$1 AND released_at IS NULL',
            [cancelRollback.id],
          )
        ).rowCount,
        1,
      );

      const activeWorkerOrder = await db.query(
        'SELECT service_order_id FROM service_order_responsibilities WHERE user_id=$1 AND released_at IS NULL LIMIT 1',
        [ids.worker1],
      );
      if (activeWorkerOrder.rowCount)
        await serviceOrderService.releaseResponsibility(
          activeWorkerOrder.rows[0].service_order_id,
          {},
          manager,
        );
      const unauthorizedOrder = await insertOrder('denied');
      await assert.rejects(
        serviceOrderService.assumeByExternalNumber(
          { sectorId: ids.sector, externalNumber: unauthorizedOrder.external },
          { id: randomUUID(), type: 'user' },
        ),
        { code: 'sectorGrantRequired' },
      );

      const rollbackOrder = await insertOrder('rollback');
      const activeForRollback = await db.query(
        'SELECT service_order_id FROM service_order_responsibilities WHERE user_id=$1 AND released_at IS NULL',
        [ids.worker1],
      );
      if (activeForRollback.rowCount)
        await serviceOrderService.releaseResponsibility(
          activeForRollback.rows[0].service_order_id,
          {},
          manager,
        );
      const events = serviceOrderService.events;
      const append = events.append;
      events.append = async () => {
        throw new Error('RF12-24 injected event failure');
      };
      try {
        await assert.rejects(
          serviceOrderService.assumeByExternalNumber(
            { sectorId: ids.sector, externalNumber: rollbackOrder.external },
            worker1Actor,
          ),
          /injected event failure/,
        );
        assert.equal(
          (
            await db.query(
              'SELECT count(*) FROM service_order_responsibilities WHERE service_order_id=$1',
              [rollbackOrder.id],
            )
          ).rows[0].count,
          '0',
        );
        assert.equal(
          (
            await db.query(
              'SELECT count(*) FROM service_order_events WHERE aggregate_id=$1',
              [rollbackOrder.id],
            )
          ).rows[0].count,
          '0',
        );
        assert.equal(
          (
            await db.query(
              'SELECT count(*) FROM service_order_outbox WHERE aggregate_id=$1',
              [rollbackOrder.id],
            )
          ).rows[0].count,
          '0',
        );
      } finally {
        events.append = append;
      }

      const after = await db.query(
        'SELECT id,external_number,sector_id,created_at FROM service_orders WHERE id = ANY($1::uuid[]) ORDER BY id',
        [before.rows.map((row) => row.id)],
      );
      assert.deepEqual(after.rows, before.rows);
      assert.equal(
        (
          await db.query(
            'SELECT count(*) FROM service_orders WHERE external_number LIKE $1',
            [`RF12-24-${suffix.slice(0, 8)}-%`],
          )
        ).rows[0].count,
        String(madeOrders.length),
      );
    } finally {
      // These test-owned fixtures are intentionally retained: domain events are append-only
      // and responsibility history is permanent. Every run uses a fresh UUID namespace.
      await Database.connection.close();
      await db.end();
    }
  },
);
