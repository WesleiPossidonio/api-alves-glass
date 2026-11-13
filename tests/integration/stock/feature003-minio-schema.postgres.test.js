import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { randomUUID } from 'node:crypto'

const enabled = process.env.RUN_POSTGRES_FEATURE003_INTEGRATION === '1'
const isolatedIntegrationTarget = process.env.DB_PORT === '55438' && process.env.DB_DATABASE === 'feature003_integration'

test('Feature 003 MinIO schema constraints, FKs and cleanup leasing on disposable PostgreSQL', { skip: !enabled }, async () => {
  assert.equal(process.env.DB_HOST, '127.0.0.1')
  assert.equal(process.env.DB_PORT, isolatedIntegrationTarget ? '55438' : '55437')
  assert.equal(process.env.DB_DATABASE, isolatedIntegrationTarget ? 'feature003_integration' : 'feature003_ephemeral')
  const db = new pg.Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_DATABASE, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD })
  await db.connect()
  const id = 'a1c20c54-50aa-4141-8d9f-c5eedec7044c'
  const bucket = `integration-${Date.now()}`
  const key = `materials/${id}/test.webp`
  const reject = async (sql, values, code = '23514') => {
    await db.query('BEGIN')
    await db.query('SAVEPOINT constraint_check')
    try { await db.query(sql, values); assert.fail('expected database constraint to reject input') }
    catch (error) { if (error.code === 'ERR_ASSERTION') throw error; assert.equal(error.code, code) }
    finally { await db.query('ROLLBACK TO SAVEPOINT constraint_check'); await db.query('RELEASE SAVEPOINT constraint_check'); await db.query('ROLLBACK') }
  }
  try {
    assert.equal((await db.query('SELECT current_database()')).rows[0].current_database, process.env.DB_DATABASE)
    const user = (await db.query('SELECT id FROM users LIMIT 1')).rows[0]?.id
    assert.ok(user)
    const existing = (await db.query('SELECT id FROM materials WHERE image_object_key IS NULL LIMIT 1')).rows[0]?.id
    assert.ok(existing)
    const sector = (await db.query('SELECT sector_id FROM warehouses LIMIT 1')).rows[0]?.sector_id
    const warehouse = (await db.query(`INSERT INTO warehouses (id,sector_id,code,name,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'ACTIVE',now(),now()) RETURNING id`, [randomUUID(), sector, `${bucket}-wh`, `${bucket} warehouse`])).rows[0].id
    const category = (await db.query('INSERT INTO material_categories (id,warehouse_id,name,created_at,updated_at) VALUES ($1,$2,$3,now(),now()) RETURNING id', [randomUUID(), warehouse, `${bucket} category`])).rows[0].id
    const materialId = (await db.query(`INSERT INTO materials (id,warehouse_id,category_id,code,name,unit_code,min_quantity,active,created_at,updated_at) VALUES ($1,$2,$3,$4,'Feature003 image test','un',0,true,now(),now()) RETURNING id`, [randomUUID(), warehouse, category, `${bucket}-MAT`])).rows[0].id
    await db.query(`INSERT INTO minio_upload_intents (bucket,object_key,created_by,lease_expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')`, [bucket,key,user])
    await reject(`INSERT INTO minio_upload_intents (bucket,object_key,created_by,lease_expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')`, [bucket,key,user], '23505')
    await reject(`UPDATE materials SET image_bucket=$2,image_object_key=$3,image_visibility='invalid' WHERE id=$1`, [materialId,bucket,key])
    await db.query(`UPDATE materials SET image_bucket=$2,image_object_key=$3,image_visibility='private' WHERE id=$1`, [materialId,bucket,key])
    await db.query(`INSERT INTO minio_cleanup_jobs (bucket,object_key,status,locked_at,locked_by,attempts) VALUES ($1,$2,'PROCESSING',now(),'test-worker',1)`, [bucket,`obsolete/${id}.webp`])
    const claim = await db.query(`WITH claimed AS (SELECT id FROM minio_cleanup_jobs WHERE status='PENDING' AND next_attempt_at<=now() FOR UPDATE SKIP LOCKED LIMIT 10) UPDATE minio_cleanup_jobs j SET status='PROCESSING',locked_at=now(),locked_by='integration-worker',attempts=attempts+1 FROM claimed WHERE j.id=claimed.id RETURNING j.id`)
    assert.ok(claim.rowCount >= 0)
    await reject(`INSERT INTO minio_cleanup_jobs (bucket,object_key,status,locked_at) VALUES ($1,$2,'PROCESSING',now())`, [bucket,'invalid/lease'])
    const indexCheck = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN ('materials_image_object_reference_idx','minio_cleanup_jobs_ready_idx','minio_cleanup_jobs_lease_idx','minio_cleanup_jobs_active_object_idx','minio_upload_intents_expired_idx')`)
    assert.equal(indexCheck.rowCount, 5)
    await db.query('BEGIN')
    await db.query('UPDATE materials SET image_object_key=$2 WHERE id=$1', [materialId, 'materials/rollback.webp'])
    await db.query('ROLLBACK')
    assert.equal((await db.query('SELECT image_object_key FROM materials WHERE id=$1', [materialId])).rows[0].image_object_key, key)
  } finally { await db.end() }
})