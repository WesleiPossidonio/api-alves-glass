// Recovery for expired upload intents and untracked legacy objects; deletion always delegates to cleanup jobs.
export class MinioOrphanRecoveryService {
  constructor({ intents, cleanupJobs, listObjects, isReferenced, gracePeriodMs = 24 * 60 * 60 * 1000, now = () => new Date() } = {}) {
    Object.assign(this, { intents, cleanupJobs, listObjects, isReferenced, gracePeriodMs, now })
  }

  async recoverExpiredIntents({ limit = 100 } = {}) {
    const expired = await this.intents.findExpiredUploading({ before: this.now(), limit })
    const results = []
    for (const intent of expired) {
      const object = { bucket: intent.bucket, objectName: intent.object_key }
      if (await this.isReferenced(object)) {
        await this.intents.markCommitted(intent.id)
        results.push({ id: intent.id, result: 'reference_found' })
        continue
      }
      if (new Date(intent.lease_expires_at).getTime() + this.gracePeriodMs > this.now().getTime()) {
        results.push({ id: intent.id, result: 'grace_period' })
        continue
      }
      await this.cleanupJobs.enqueue({ bucket: object.bucket, object_key: object.objectName })
      await this.intents.markAbandoned(intent.id, 'expired_upload_recovered')
      results.push({ id: intent.id, result: 'queued' })
    }
    return results
  }

  async findUntrackedObjects({ buckets, limit = 1000 } = {}) {
    const known = new Set(await this.intents.listKnownObjectKeys({ buckets }))
    const objects = await this.listObjects({ buckets, limit })
    const candidates = []
    for (const object of objects) {
      const key = `${object.bucket}/${object.objectName}`
      if (known.has(key) || this.now().getTime() - new Date(object.lastModified).getTime() < this.gracePeriodMs) continue
      if (await this.isReferenced(object)) continue
      candidates.push(object)
    }
    return candidates
  }
}

export default MinioOrphanRecoveryService