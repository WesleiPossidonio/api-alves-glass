import { randomUUID } from 'node:crypto'
import path from 'node:path'
import minioClient from '../../config/minio.js'

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const imageTypes = new Map([
  ['image/jpeg', { extension: '.jpg', signature: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff }],
  ['image/png', { extension: '.png', signature: buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) }],
  ['image/webp', { extension: '.webp', signature: buffer => buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' }],
])

export function validateImage(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0 || file.buffer.length > MAX_IMAGE_BYTES) return { error: 'validation' }
  const image = imageTypes.get(file.mimetype)
  if (!image || !image.signature(file.buffer)) return { error: 'unsupportedMediaType' }
  return { contentType: file.mimetype, extension: image.extension, size: file.buffer.length }
}

function configuredBuckets(env) {
  const publicBucket = env.MINIO_PUBLIC_BUCKET
  const privateBucket = env.MINIO_PRIVATE_BUCKET
  if (!publicBucket || !privateBucket || publicBucket === privateBucket) throw new Error('Distinct MINIO_PUBLIC_BUCKET and MINIO_PRIVATE_BUCKET values are required')
  return { public: publicBucket, private: privateBucket }
}

export class StorageServiceClient {
  constructor({ client = minioClient, env = process.env, idFactory = randomUUID } = {}) {
    this.client = client
    this.env = env
    this.idFactory = idFactory
  }

  // Backwards-compatible upload used by non-image resources (for example budget PDFs).
  async upload(file, folder = '') {
    const extension = path.extname(file.originalname ?? '')
    const objectName = [String(folder).replace(/^\/+|\/+$/g, ''), `${this.idFactory()}${extension}`].filter(Boolean).join('/')
    const bucket = this.env.MINIO_BUCKET
    if (!bucket) throw new Error('MINIO_BUCKET is required for legacy uploads')
    await this.client.putObject(bucket, objectName, file.buffer, file.size, { 'Content-Type': file.mimetype })
    return objectName
  }

  async uploadImage(file, folder = '', visibility = 'private') {
    const target = this.prepareImageUpload(file, folder, visibility)
    if (target.error) return target
    await this.client.putObject(target.bucket, target.objectName, file.buffer, target.size, { 'Content-Type': target.contentType })
    return target
  }

  prepareImageUpload(file, folder = '', visibility = 'private') {
    const validation = validateImage(file)
    if (validation.error) return validation
    if (!['public', 'private'].includes(visibility)) return { error: 'validation' }
    const buckets = configuredBuckets(this.env)
    const prefix = String(folder).split('/').filter(Boolean)
    if (prefix.some(part => part === '.' || part === '..' || /[\\\0]/.test(part))) return { error: 'validation' }
    const objectName = [...prefix, `${this.idFactory()}${validation.extension}`].join('/')
    return { bucket: buckets[visibility], objectName, contentType: validation.contentType, size: validation.size, visibility }
  }

  async putPreparedImage(file, target) {
    const validation = validateImage(file)
    if (!target?.bucket || !target?.objectName || validation.error || validation.contentType !== target.contentType || validation.size !== target.size) throw new TypeError('valid prepared image target is required')
    await this.client.putObject(target.bucket, target.objectName, file.buffer, target.size, { 'Content-Type': target.contentType })
    return target
  }

  async replaceImage({ file, folder = '', visibility = 'private', previousObject = null, transaction, updateReference, enqueueCleanup }) {
    if (typeof updateReference !== 'function') throw new TypeError('updateReference callback is required')
    const uploaded = await this.uploadImage(file, folder, visibility)
    if (uploaded.error) return uploaded
    try {
      await updateReference(uploaded, { transaction, enqueueCleanup, previousObject })
    } catch (error) {
      // Best-effort compensation for an object uploaded before its database reference committed.
      // Durable orphan reconciliation is still required because process/network failure can interrupt this.
      try { await this.client.removeObject(uploaded.bucket, uploaded.objectName) } catch { /* reconciliation handles orphan */ }
      throw error
    }
    return { ...uploaded, previousObjectPendingCleanup: Boolean(previousObject) }
  }

  async removeIfUnreferenced(object, { isReferenced, transaction } = {}) {
    if (!object?.bucket || !object?.objectName || typeof isReferenced !== 'function') throw new TypeError('object and reference check are required')
    if (await isReferenced(object, { transaction })) return { deleted: false, reason: 'referenced' }
    await this.client.removeObject(object.bucket, object.objectName)
    return { deleted: true }
  }

  async getPrivateUrl(objectName, expirySeconds = 300) {
    const { private: privateBucket } = configuredBuckets(this.env)
    if (!Number.isInteger(expirySeconds) || expirySeconds < 1 || expirySeconds > 7 * 24 * 60 * 60) throw new TypeError('expirySeconds is invalid')
    return this.client.presignedGetObject(privateBucket, objectName, expirySeconds)
  }

  static extensionForName(filename) { return path.extname(filename).toLowerCase() }
}

export default new StorageServiceClient()