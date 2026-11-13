import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import Database from '../../../src/database/index.js'
import Material from '../../../src/app/models/Material.js'
import MaterialCategory from '../../../src/app/models/MaterialCategory.js'
import { MaterialImageServiceClient } from '../../../src/app/services/MaterialImageService.js'
import { StorageServiceClient } from '../../../src/app/services/StorageService.js'
import minioClient from '../../../src/config/minio.js'
import { MinioUploadIntentRepositoryClient } from '../../../src/app/repositories/MinioUploadIntentRepository.js'
import { MinioCleanupJobRepositoryClient } from '../../../src/app/repositories/MinioCleanupJobRepository.js'

const enabled = process.env.RUN_FEATURE003_MEDIA_POSTGRES_MINIO === '1'
const image = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]), mimetype: 'image/jpeg' }

test('Feature 003 image reference, intent, cleanup and MinIO object stay transactionally consistent', { skip: !enabled }, async t => {
  assert.equal(process.env.DB_HOST, '127.0.0.1')
  assert.equal(process.env.DB_PORT, '55438')
  assert.equal(process.env.DB_DATABASE, 'feature003_integration')
  assert.equal(process.env.MINIO_ENDPOINT, '127.0.0.1')
  assert.equal(process.env.MINIO_PORT, '59000')
  assert.equal(await minioClient.bucketExists(process.env.MINIO_PRIVATE_BUCKET), true)

  const user = await Database.models.User.findOne({ attributes: ['id'] })
  assert.ok(user, 'isolated integration database has an actor for the FK')
  const category = await MaterialCategory.findOne({ attributes: ['id', 'warehouse_id'] })
  assert.ok(category, 'isolated integration database has a category/warehouse fixture')
  const material = await Material.create({
    id: randomUUID(), warehouse_id: category.warehouse_id, category_id: category.id,
    code: `IT-MEDIA-${randomUUID()}`, name: 'Feature003 media transaction test', unit_code: 'un',
  })
  const created = []
  const intentKeys = []
  t.after(async () => {
    const objectKeys = created.map(object => object.objectName)
    await Material.destroy({ where: { id: material.id } })
    if (objectKeys.length) {
      await Database.models.MinioCleanupJob.destroy({ where: { object_key: objectKeys } })
    }
    if (intentKeys.length) await Database.models.MinioUploadIntent.destroy({ where: { object_key: intentKeys } })
    for (const object of created) {
      try { await minioClient.removeObject(object.bucket, object.objectName) }
      catch (error) { console.error('Test-owned media object needs manual cleanup', { ...object, error: error.message }) }
    }
  })

  const storage = new StorageServiceClient()
  const intents = new MinioUploadIntentRepositoryClient(Database.models.MinioUploadIntent)
  const jobs = new MinioCleanupJobRepositoryClient(Database.models.MinioCleanupJob)
  const baseMaterials = {
    findById: id => Material.findByPk(id),
    findByIdForUpdate: (id, transaction) => Material.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }),
  }
  const service = new MaterialImageServiceClient({
    database: Database, materials: baseMaterials, storage, intents, cleanupJobs: jobs, canAccessMaterial: async () => true,
  })
  const actor = { id: user.id, role: 'admin' }

  const first = await service.replace(actor, material.id, image)
  created.push({ bucket: first.image.bucket, objectName: first.image.objectKey })
  intentKeys.push(first.image.objectKey)
  let saved = await Material.findByPk(material.id)
  assert.equal(saved.image_bucket, first.image.bucket)
  assert.equal(saved.image_object_key, first.image.objectKey)
  assert.equal(saved.image_visibility, 'private')
  assert.deepEqual(await minioClient.statObject(first.image.bucket, first.image.objectKey).then(({ size, metaData }) => ({ size, contentType: metaData['content-type'] })), { size: image.buffer.length, contentType: image.mimetype })
  const committedIntent = await Database.models.MinioUploadIntent.findOne({ where: { bucket: first.image.bucket, object_key: first.image.objectKey } })
  assert.equal(committedIntent.status, 'COMMITTED')
  assert.ok(committedIntent.completed_at)

  const second = await service.replace(actor, material.id, { buffer: Buffer.from([0xff,0xd8,0xff,0x02,0x03]), mimetype: 'image/jpeg' })
  created.push({ bucket: second.image.bucket, objectName: second.image.objectKey })
  intentKeys.push(second.image.objectKey)
  assert.notEqual(second.image.objectKey, first.image.objectKey)
  saved = await Material.findByPk(material.id)
  assert.equal(saved.image_object_key, second.image.objectKey)
  assert.equal(await minioClient.statObject(first.image.bucket, first.image.objectKey).then(() => true), true, 'previous object is retained until guarded cleanup')
  const cleanup = await Database.models.MinioCleanupJob.findOne({ where: { bucket: first.image.bucket, object_key: first.image.objectKey } })
  assert.equal(cleanup.status, 'PENDING')

  const before = await Database.models.MinioUploadIntent.count({ where: { bucket: second.image.bucket } })
  const failingMaterials = {
    findById: id => Material.findByPk(id),
    findByIdForUpdate: async (id, transaction) => {
      const current = await Material.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE })
      const update = current.update.bind(current)
      current.update = async (...args) => {
        await update(...args)
        throw new Error('simulated PostgreSQL failure after reference update before commit')
      }
      return current
    },
  }
  const failingStorage = {
    prepareImageUpload: (...args) => storage.prepareImageUpload(...args),
    putPreparedImage: async (file, target) => {
      const uploaded = await storage.putPreparedImage(file, target)
      created.push({ bucket: uploaded.bucket, objectName: uploaded.objectName })
      intentKeys.push(uploaded.objectName)
      return uploaded
    },
  }
  const failingService = new MaterialImageServiceClient({
    database: Database, materials: { ...baseMaterials, findByIdForUpdate: failingMaterials.findByIdForUpdate }, storage: failingStorage,
    intents, cleanupJobs: jobs, canAccessMaterial: async () => true,
  })
  await assert.rejects(() => failingService.replace(actor, material.id, image), /simulated PostgreSQL failure/)
  const afterFailure = await Database.models.MinioUploadIntent.findOne({ where: { bucket: second.image.bucket }, order: [['created_at', 'DESC']] })
  assert.equal(afterFailure.status, 'ABANDONED')
  assert.equal(await Database.models.MinioUploadIntent.count({ where: { bucket: second.image.bucket } }), before + 1)
  assert.equal((await Material.findByPk(material.id)).image_object_key, second.image.objectKey)
  assert.equal(await minioClient.statObject(afterFailure.bucket, afterFailure.object_key).then(() => true), true, 'post-PUT DB failure leaves a known orphan for safe recovery')
})