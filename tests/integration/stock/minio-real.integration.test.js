import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import minioClient from '../../../src/config/minio.js'
import { MaterialImageServiceClient } from '../../../src/app/services/MaterialImageService.js'
import { StorageServiceClient } from '../../../src/app/services/StorageService.js'

const enabled = process.env.FEATURE003_MINIO_INTEGRATION === '1'
const storage = new StorageServiceClient()
const types = [
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0x00])],
  ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])],
  ['image/webp', Buffer.from('RIFF0000WEBP', 'ascii')],
]

test('Feature 003 media integration against explicitly authorized isolated MinIO', { skip: !enabled }, async t => {
  assert.equal(process.env.MINIO_ENDPOINT, '127.0.0.1')
  assert.equal(process.env.MINIO_PORT, '59000')
  assert.equal(process.env.MINIO_USE_SSL, 'false')
  const publicBucket = process.env.MINIO_PUBLIC_BUCKET
  const privateBucket = process.env.MINIO_PRIVATE_BUCKET
  assert.ok(publicBucket && privateBucket && publicBucket !== privateBucket)
  for (const bucket of [publicBucket, privateBucket]) assert.equal(await minioClient.bucketExists(bucket), true)

  const prefix = `materials/feature003-test-${randomUUID()}`
  const created = []
  t.after(async () => {
    // Remove only exact keys recorded as created in this run; never enumerate or delete prior objects.
    for (const object of created) {
      try { await minioClient.removeObject(object.bucket, object.objectName) }
      catch (error) { console.error('Test-owned MinIO object needs manual cleanup', { bucket: object.bucket, objectName: object.objectName, error: error.message }) }
    }
  })

  for (const [mimetype, buffer] of types) {
    const upload = await storage.uploadImage({ buffer, mimetype }, prefix, 'private')
    created.push({ bucket: upload.bucket, objectName: upload.objectName })
    assert.equal(upload.bucket, privateBucket)
    const stat = await minioClient.statObject(privateBucket, upload.objectName)
    assert.equal(stat.size, buffer.length)
    assert.equal(stat.metaData['content-type'], mimetype)
    const anonymous = await fetch(`http://127.0.0.1:59000/${privateBucket}/${upload.objectName}`)
    assert.equal(anonymous.status, 403, 'private object is not readable without authorization')
    const url = await storage.getPrivateUrl(upload.objectName, 60)
    const response = await fetch(url)
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), buffer)
    const expiredUrl = await storage.getPrivateUrl(upload.objectName, 1)
    await new Promise(resolve => setTimeout(resolve, 1200))
    const expiredResponse = await fetch(expiredUrl)
    assert.equal(expiredResponse.status, 403, 'expired presigned URL is rejected')
  }

  const publicUpload = await storage.uploadImage({ buffer: types[0][1], mimetype: types[0][0] }, prefix, 'public')
  created.push({ bucket: publicUpload.bucket, objectName: publicUpload.objectName })
  assert.equal(publicUpload.bucket, publicBucket)
  assert.equal((await minioClient.statObject(publicBucket, publicUpload.objectName)).size, types[0][1].length)

  assert.deepEqual(await storage.uploadImage({ buffer: Buffer.from('not an image'), mimetype: 'image/jpeg' }, prefix, 'private'), { error: 'unsupportedMediaType' })
  assert.deepEqual(await storage.uploadImage({ buffer: Buffer.alloc(5 * 1024 * 1024 + 1), mimetype: 'image/png' }, prefix, 'private'), { error: 'validation' })

  const materialId = randomUUID()
  const material = {
    id: materialId, image_bucket: null, image_object_key: null, image_visibility: null,
    async update(changes) { Object.assign(material, changes) },
  }
  const intents = {
    async create(data) { return { ...data, id: randomUUID() } },
    async renewLease() {}, async markCommitted() {}, async markAbandoned() {},
  }
  const cleanupJobs = {
    async withObjectLock(_object, callback) { return callback({}) },
    async enqueue() {},
  }
  const imageService = new MaterialImageServiceClient({
    database: { connection: { async transaction(callback) { return callback({}) } } },
    materials: { async findById() { return material }, async findByIdForUpdate() { return material } },
    storage, intents, cleanupJobs,
    canAccessMaterial: async actor => actor.id === 'allowed-operator',
  })

  assert.deepEqual(await imageService.replace({ id: 'denied-operator', role: 'user' }, materialId, { buffer: types[0][1], mimetype: types[0][0] }), { error: 'notFound' })
  assert.equal(material.image_object_key, null)

  const first = await imageService.replace({ id: 'allowed-operator', role: 'user' }, materialId, { buffer: types[0][1], mimetype: types[0][0] })
  created.push({ bucket: first.image.bucket, objectName: first.image.objectKey })
  assert.equal(first.image.bucket, privateBucket)
  const firstKey = first.image.objectKey

  const second = await imageService.replace({ id: 'allowed-operator', role: 'user' }, materialId, { buffer: types[1][1], mimetype: types[1][0] })
  created.push({ bucket: second.image.bucket, objectName: second.image.objectKey })
  assert.notEqual(second.image.objectKey, firstKey)
  assert.equal(material.image_object_key, second.image.objectKey)
  assert.equal((await minioClient.statObject(privateBucket, firstKey)).size, types[0][1].length, 'replacement leaves prior object for guarded cleanup')

  const failedTarget = storage.prepareImageUpload({ buffer: types[2][1], mimetype: types[2][0] }, prefix, 'private')
  await assert.rejects(() => storage.replaceImage({
    file: { buffer: types[2][1], mimetype: types[2][0] }, folder: prefix, visibility: 'private',
    updateReference: async () => { throw new Error('simulated PostgreSQL reference commit failure') },
  }), /simulated PostgreSQL reference commit failure/)
  assert.notEqual(failedTarget.objectName, second.image.objectKey)
  await assert.rejects(() => minioClient.statObject(privateBucket, failedTarget.objectName), error => error?.code === 'NotFound' || error?.code === 'NoSuchKey')

  const stillReferenced = await storage.removeIfUnreferenced(
    { bucket: privateBucket, objectName: second.image.objectKey },
    { isReferenced: async () => true },
  )
  assert.deepEqual(stillReferenced, { deleted: false, reason: 'referenced' })
  assert.equal((await minioClient.statObject(privateBucket, second.image.objectKey)).size, types[1][1].length)

  // No ListBucket, no anonymous policy changes, and no deletion of any object not created above.
})