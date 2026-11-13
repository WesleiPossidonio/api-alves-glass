import minioClient from '../../config/minio.js'
import MinioCleanupJobRepository from '../repositories/MinioCleanupJobRepository.js'
import Material from '../models/Material.js'

const defaultJobs = MinioCleanupJobRepository
const defaultReferenceCheck = async (object, { transaction } = {}) => Material.findOne({
  where: { image_bucket: object.bucket, image_object_key: object.objectName }, transaction, attributes: ['id'],
}).then(Boolean)

export class MinioCleanupServiceClient {
  constructor({ jobs = defaultJobs, isReferenced = defaultReferenceCheck, client = minioClient, now = () => new Date() } = {}) {
    this.jobs = jobs
    this.isReferenced = isReferenced
    this.client = client
    this.now = now
  }

  async runBatch({ workerId, limit = 25 } = {}) {
    if (!this.jobs || typeof this.isReferenced !== 'function') throw new TypeError('cleanup dependencies are required')
    await this.jobs.recoverExpired({ now: this.now() })
    const jobs = await this.jobs.claimBatch({ workerId, limit, now: this.now() })
    const results = []
    for (const job of jobs) {
      const object = { bucket: job.bucket, objectName: job.object_key }
      try {
        // Serialize the reference check with Material image-reference updates. Both operations use
        // the same advisory-lock key; object keys are immutable and never reattached after cleanup.
        await this.jobs.withObjectLock(object, async transaction => {
        if (await this.isReferenced(object, { transaction })) {
          await this.jobs.block(job.id, 'object_is_referenced')
          results.push({ id: job.id, result: 'blocked' })
          return
        }
        // S3-compatible delete is idempotent; a not-found response is treated as success.
        try { await this.client.removeObject(object.bucket, object.objectName) }
        catch (error) {
          if (error.code !== 'NoSuchKey' && error.code !== 'NotFound' && error.statusCode !== 404) throw error
        }
        await this.jobs.complete(job.id)
        results.push({ id: job.id, result: 'done' })
        })
      } catch (error) {
        const attempt = Number(job.attempts) || 1
        const delay = Math.min(24 * 60 * 60 * 1000, 1000 * (2 ** Math.min(attempt, 16)))
        await this.jobs.retry(job.id, error.message, { nextAttemptAt: new Date(this.now().getTime() + delay) })
        results.push({ id: job.id, result: 'retry' })
      }
    }
    return results
  }
}

export default MinioCleanupServiceClient