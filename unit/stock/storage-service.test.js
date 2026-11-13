import assert from 'node:assert/strict'
import test from 'node:test'
import { StorageServiceClient, MAX_IMAGE_BYTES, validateImage } from '../../src/app/services/StorageService.js'

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00])
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
const webp = Buffer.from('RIFF0000WEBP', 'ascii')

test('image validation enforces real JPEG/PNG/WebP signatures and exact 5 MiB bound', () => {
  assert.equal(validateImage({ buffer: jpeg, mimetype: 'image/jpeg' }).extension, '.jpg')
  assert.equal(validateImage({ buffer: png, mimetype: 'image/png' }).extension, '.png')
  assert.equal(validateImage({ buffer: webp, mimetype: 'image/webp' }).extension, '.webp')
  assert.deepEqual(validateImage({ buffer: Buffer.from('not jpeg'), mimetype: 'image/jpeg' }), { error: 'unsupportedMediaType' })
  assert.deepEqual(validateImage({ buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1), mimetype: 'image/png' }), { error: 'validation' })
  assert.equal(validateImage({ buffer: Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES - png.length)]), mimetype: 'image/png' }).size, MAX_IMAGE_BYTES)
})

test('image uploads use distinct configured bucket and unique server-generated keys', async () => {
  const writes = []
  const service = new StorageServiceClient({
    client: { putObject: async (...args) => writes.push(args) },
    env: { MINIO_PUBLIC_BUCKET: 'catalog-public', MINIO_PRIVATE_BUCKET: 'catalog-private' },
    idFactory: (() => { let n = 0; return () => `uuid-${++n}` })(),
  })
  const first = await service.uploadImage({ buffer: jpeg, mimetype: 'image/jpeg' }, 'materials', 'public')
  const second = await service.uploadImage({ buffer: jpeg, mimetype: 'image/jpeg' }, 'materials', 'private')
  assert.equal(first.bucket, 'catalog-public')
  assert.equal(second.bucket, 'catalog-private')
  assert.notEqual(first.objectName, second.objectName)
  assert.equal(writes.length, 2)
  assert.equal(writes[0][4]['Content-Type'], 'image/jpeg')
  await assert.rejects(() => new StorageServiceClient({ client: {}, env: { MINIO_PUBLIC_BUCKET: 'same', MINIO_PRIVATE_BUCKET: 'same' } }).uploadImage({ buffer: jpeg, mimetype: 'image/jpeg' }))
})

test('replacement leaves old object for durable cleanup and compensates failed reference writes', async () => {
  const removed = []
  const service = new StorageServiceClient({
    client: { putObject: async () => {}, removeObject: async (...args) => removed.push(args) },
    env: { MINIO_PUBLIC_BUCKET: 'catalog-public', MINIO_PRIVATE_BUCKET: 'catalog-private' },
    idFactory: () => 'new-key',
  })
  const previousObject = { bucket: 'catalog-private', objectName: 'materials/old.jpg' }
  let callbackArgs
  const result = await service.replaceImage({
    file: { buffer: jpeg, mimetype: 'image/jpeg' }, folder: 'materials', previousObject,
    transaction: { id: 'transaction' },
    updateReference: async (...args) => { callbackArgs = args },
  })
  assert.equal(result.previousObjectPendingCleanup, true)
  assert.equal(callbackArgs[1].previousObject, previousObject)
  assert.deepEqual(removed, [], 'replacement must not synchronously delete previous object')

  await assert.rejects(() => service.replaceImage({
    file: { buffer: jpeg, mimetype: 'image/jpeg' }, folder: 'materials',
    updateReference: async () => { throw new Error('commit failed') },
  }), /commit failed/)
  assert.deepEqual(removed, [['catalog-private', 'materials/new-key.jpg']])
})

test('reference check prevents object deletion while still referenced', async () => {
  const removed = []
  const service = new StorageServiceClient({ client: { removeObject: async (...args) => removed.push(args) }, env: {} })
  const object = { bucket: 'catalog-private', objectName: 'key.jpg' }
  assert.deepEqual(await service.removeIfUnreferenced(object, { isReferenced: async () => true }), { deleted: false, reason: 'referenced' })
  assert.deepEqual(removed, [])
  assert.deepEqual(await service.removeIfUnreferenced(object, { isReferenced: async () => false }), { deleted: true })
  assert.deepEqual(removed, [['catalog-private', 'key.jpg']])
})