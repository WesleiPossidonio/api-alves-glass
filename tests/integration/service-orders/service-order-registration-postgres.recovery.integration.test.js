import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

const enabled =
  process.env.RUN_POSTGRES_SERVICE_ORDER_RECOVERY_INTEGRATION === '1';

test(
  'Feature 004 RF-01–RF-06 PostgreSQL recovery registration contract',
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
    };
    assert.equal(process.env.DB_HOST, expected.host);
    assert.equal(process.env.DB_PORT, expected.port);
    assert.equal(process.env.DB_DATABASE, expected.database);
    assert.equal(process.env.DB_USERNAME, expected.user);

    const db = new pg.Client({
      host: expected.host,
      port: Number(expected.port),
      database: expected.database,
      user: expected.user,
      password: process.env.DB_PASSWORD,
    });
    await db.connect();
    const suffix = randomUUID();
    const sectorA = randomUUID();
    const sectorB = randomUUID();
    const clientId = randomUUID();
    const userId = randomUUID();
    const orderA = randomUUID();
    const orderB = randomUUID();
    const productA = randomUUID();
    const productB = randomUUID();
    try {
      const identity = await db.query(
        'SELECT current_database() db,current_user usr,version() version',
      );
      assert.equal(identity.rows[0].db, expected.database);
      assert.equal(identity.rows[0].usr, expected.user);
      assert.match(identity.rows[0].version, /PostgreSQL 17/);

      const migrations = await db.query(
        'SELECT name FROM "SequelizeMeta" WHERE name=$1',
        ['20261122000000-service-orders-text-number-fifo-index.cjs'],
      );
      assert.equal(migrations.rowCount, 1);
      const indexes = await db.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname='public'
         AND tablename='service_orders' AND indexname='service_orders_fifo_idx'`,
      );
      assert.equal(indexes.rowCount, 1);
      assert.match(indexes.rows[0].indexdef, /queue_entered_at, id\)/);
      assert.doesNotMatch(indexes.rows[0].indexdef, /external_number::numeric/);

      await db.query('BEGIN');
      try {
        const assertRejectedInsert = async (
          statement,
          values,
          code,
          constraint,
        ) => {
          await db.query('SAVEPOINT expected_constraint_failure');
          await assert.rejects(
            db.query(statement, values),
            (error) =>
              error.code === code &&
              (!constraint || error.constraint === constraint),
          );
          await db.query('ROLLBACK TO SAVEPOINT expected_constraint_failure');
          await db.query('RELEASE SAVEPOINT expected_constraint_failure');
        };
        const now = new Date();
        await db.query(
          `INSERT INTO sectors(id,code,name,created_at,updated_at)
           VALUES($1,$2,$3,$4,$4),($5,$6,$7,$4,$4)`,
          [
            sectorA,
            `A${suffix.replaceAll('-', '').slice(0, 30)}`,
            `Recovery sector A ${suffix}`,
            now,
            sectorB,
            `B${suffix.replaceAll('-', '').slice(0, 30)}`,
            `Recovery sector B ${suffix}`,
          ],
        );
        await db.query(
          `INSERT INTO client(id,name,email,phone,client_status,cep,rua,number_house,bairro,cidade,uf,created_at,updated_at)
           VALUES($1,$2,$3,'555','active','00000','Test','1','Test','Test','SP',$4,$4)`,
          [clientId, `RF01-06 Client ${suffix}`, `${suffix}@example.test`, now],
        );
        await db.query(
          `INSERT INTO users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at)
           VALUES($1,$2,$3,'recovery-test-only','user','active','',$4,$4)`,
          [userId, `RF01-06 User ${suffix}`, `${suffix}@users.test`, now],
        );
        await db.query(
          `INSERT INTO user_sectors(user_id,sector_id,granted_by,created_at)
           VALUES($1,$2,$1,$3),($1,$4,$1,$3)`,
          [userId, sectorA, now, sectorB],
        );

        const insertOrder = async ({ id, sectorId, productId }) => {
          await db.query(
            `INSERT INTO service_orders
             (id,external_number,client_id,sector_id,due_at,public_status,administrative_state,
              operational_version,queue_entered_at,production_completed,created_by,notes,created_at,updated_at)
             VALUES($1,'000123-A',$2,$3,$4,'CREATED','ACTIVE',0,$5,false,$6,$7,$5,$5)`,
            [id, clientId, sectorId, '2027-01-02T00:00:00Z', now, userId, null],
          );
          await db.query(
            `INSERT INTO service_order_products
             (id,service_order_id,name,description,quantity,unit_code,measurements,specification_revision,
              completed_quantity,blocked_quantity,created_at,updated_at)
             VALUES($1,$2,'Panel',NULL,1,'UN',$3::jsonb,1,0,0,$4,$4)`,
            [
              productId,
              id,
              JSON.stringify({ widthMm: '10', heightMm: '20' }),
              now,
            ],
          );
        };
        await insertOrder({
          id: orderA,
          sectorId: sectorA,
          productId: productA,
        });
        await insertOrder({
          id: orderB,
          sectorId: sectorB,
          productId: productB,
        });
        const stored = await db.query(
          `SELECT id,external_number,sector_id,client_id FROM service_orders
           WHERE id=ANY($1::uuid[]) ORDER BY sector_id`,
          [[orderA, orderB]],
        );
        assert.equal(stored.rowCount, 2);
        assert.deepEqual(
          stored.rows.map((row) => row.external_number),
          ['000123-A', '000123-A'],
        );
        assert.equal(new Set(stored.rows.map((row) => row.sector_id)).size, 2);
        assert.ok(stored.rows.every((row) => row.client_id === clientId));

        await assertRejectedInsert(
          `INSERT INTO service_orders
             (id,external_number,client_id,sector_id,due_at,public_status,administrative_state,
              operational_version,queue_entered_at,production_completed,created_by,created_at,updated_at)
             VALUES($1,'000123-A',$2,$3,$4,'CREATED','ACTIVE',0,$5,false,$6,$5,$5)`,
          [
            randomUUID(),
            clientId,
            sectorA,
            '2027-01-02T00:00:00Z',
            now,
            userId,
          ],
          '23505',
          'service_orders_sector_external_number_ckey',
        );
        await assertRejectedInsert(
          `INSERT INTO service_orders
             (id,external_number,client_id,sector_id,due_at,public_status,administrative_state,
              operational_version,queue_entered_at,production_completed,created_by,created_at,updated_at)
             VALUES($1,'BAD-CLIENT',$2,$3,$4,'CREATED','ACTIVE',0,$5,false,$6,$5,$5)`,
          [
            randomUUID(),
            randomUUID(),
            sectorA,
            '2027-01-02T00:00:00Z',
            now,
            userId,
          ],
          '23503',
          'service_orders_client_id_fkey',
        );
        await assertRejectedInsert(
          `INSERT INTO service_order_products
             (id,service_order_id,name,quantity,unit_code,measurements,specification_revision,completed_quantity,blocked_quantity,created_at,updated_at)
             VALUES($1,$2,'No measurements',NULL,'UN','{}'::jsonb,1,0,0,$3,$3)`,
          [randomUUID(), orderA, now],
          '23502',
          null,
        );
        await assertRejectedInsert(
          `INSERT INTO service_orders
             (id,external_number,client_id,sector_id,due_at,public_status,administrative_state,
              operational_version,queue_entered_at,production_completed,created_by,created_at,updated_at)
             VALUES($1,'BAD-SECTOR',$2,$3,$4,'CREATED','ACTIVE',0,$5,false,$6,$5,$5)`,
          [
            randomUUID(),
            clientId,
            randomUUID(),
            '2027-01-02T00:00:00Z',
            now,
            userId,
          ],
          '23503',
          'service_orders_sector_id_fkey',
        );
      } finally {
        await db.query('ROLLBACK');
      }

      const leftovers = await db.query(
        `SELECT
          (SELECT count(*) FROM sectors WHERE id=ANY($1::uuid[])) sectors,
          (SELECT count(*) FROM client WHERE id=$2) clients,
          (SELECT count(*) FROM users WHERE id=$3) users,
          (SELECT count(*) FROM service_orders WHERE id=ANY($4::uuid[])) orders,
          (SELECT count(*) FROM service_order_products WHERE id=ANY($5::uuid[])) products`,
        [
          [sectorA, sectorB],
          clientId,
          userId,
          [orderA, orderB],
          [productA, productB],
        ],
      );
      assert.deepEqual(
        Object.values(leftovers.rows[0]).map(Number),
        [0, 0, 0, 0, 0],
      );
    } finally {
      await db.end();
    }
  },
);
