import assert from 'node:assert/strict'
import test from 'node:test'
import { MaterialImageServiceClient } from '../../src/app/services/MaterialImageService.js'

const file = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0]), mimetype: 'image/jpeg' }

function harness({ failPut = false, failCommit = false, old = null } = {}) {
  const timeline = []
  const material = {
    image_bucket: old?.bucket ?? null,
    image_object_key: old?.objectName ?? null,
    update: async (changes, { transaction }) => {
      timeline.push(['material.update', transaction.id, changes])
      if (failCommit) throw new Error('reference commit failed')
      Object.assign(material, changes)
    },
  }
  const db = { connection: { transaction: async callback => {
    const tx = { id: `tx-${timeline.length}` }
    timeline.push(['transaction.begin', tx.id])
    try { const result = await callback(tx); timeline.push(['transaction.commit', tx.id]); return result }
    catch (error) { timeline.push(['transaction.rollback', tx.id]); throw error }
  } } }
  const storage = {
    prepareImageUpload: () => ({ bucket: 'private', objectName: 'materials/id/new.jpg', contentType: 'image/jpeg', size: file.buffer.length }),
    putPreparedImage: async () => { timeline.push(['minio.put']); if (failPut) throw new Error('put failed'); return { bucket: 'private', objectName: 'materials/id/new.jpg' } },
  }
  const intents = {
    create: async (data, { transaction }) => { timeline.push(['intent.create', transaction.id, data]); return { id: 'intent-1' } },
    renewLease: async id => timeline.push(['intent.renew', id]),
    markCommitted: async (id, { transaction }) => timeline.push(['intent.committed', transaction.id, id]),
    markAbandoned: async (id, reason) => timeline.push(['intent.abandoned', id, reason]),
  }
  const cleanupJobs = {
    withObjectLock: async (_object, callback) => {
      const tx = { id: `lock-${timeline.length}` }
      timeline.push(['transaction.begin', tx.id])
      try { const result = await callback(tx); timeline.push(['transaction.commit', tx.id]); return result }
      catch (error) { timeline.push(['transaction.rollback', tx.id]); throw error }
    },
    enqueue: async (data, { transaction }) => timeline.push(['cleanup.enqueue', transaction.id, data]),
  }
  const service = new MaterialImageServiceClient({
    database: db, materials: { findById: async () => material, findByIdForUpdate: async (_id, tx) => { timeline.push(['material.lock', tx.id]); return material } },
    storage, intents, cleanupJobs, canAccessMaterial: async () => true,
  })
  return { service, timeline, material }
}

test('material image upload writes durable intent before MinIO and atomically swaps reference and cleanup job', async () => {
  const { service, timeline, material } = harness({ old: { bucket: 'private', objectName: 'materials/id/old.jpg' } })
  const result = await service.replace({ id: 'user-1', role: 'admin' }, 'id', file)
  assert.equal(result.image.objectKey, 'materials/id/new.jpg')
  assert.ok(timeline.findIndex(x => x[0] === 'intent.create') < timeline.findIndex(x => x[0] === 'minio.put'))
  assert.ok(timeline.findIndex(x => x[0] === 'material.update') < timeline.findIndex(x => x[0] === 'intent.committed'))
  assert.ok(timeline.findIndex(x => x[0] === 'intent.committed') < timeline.findIndex(x => x[0] === 'cleanup.enqueue'))
  assert.equal(material.image_object_key, 'materials/id/new.jpg')
  assert.equal(timeline.some(x => x[0] === 'minio.remove'), false, 'no synchronous object deletion')
})

test('failed MinIO upload leaves a recoverable intent and does not replace the material reference', async () => {
  const { service, timeline, material } = harness({ failPut: true, old: { bucket: 'private', objectName: 'old.jpg' } })
  await assert.rejects(() => service.replace({ id: 'user-1', role: 'admin' }, 'id', file), /put failed/)
  assert.ok(timeline.some(x => x[0] === 'intent.abandoned'))
  assert.equal(material.image_object_key, 'old.jpg')
  assert.equal(timeline.some(x => x[0] === 'cleanup.enqueue'), false)
})

test('failed PostgreSQL reference transaction queues no old-object cleanup', async () => {
  const { service, timeline, material } = harness({ failCommit: true, old: { bucket: 'private', objectName: 'old.jpg' } })
  await assert.rejects(() => service.replace({ id: 'user-1', role: 'admin' }, 'id', file), /reference commit failed/)
  assert.ok(timeline.some(x => x[0] === 'transaction.rollback'))
  assert.ok(timeline.some(x => x[0] === 'intent.abandoned'))
  assert.equal(timeline.some(x => x[0] === 'cleanup.enqueue'), false)
  assert.equal(material.image_object_key, 'old.jpg')
})

test('image replacement is not exposed unless cleanup and intent repositories are supplied', async () => {
  const service = new MaterialImageServiceClient({ materials: { findById: async () => ({}) }, canAccessMaterial: async () => true })
  assert.deepEqual(await service.replace({ id: 'a', role: 'admin' }, 'id', file), { error: 'storagePersistenceUnavailable' })
})