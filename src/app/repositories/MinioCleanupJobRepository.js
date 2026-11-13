import { Op } from 'sequelize'
import MinioCleanupJob from '../models/MinioCleanupJob.js'

export class MinioCleanupJobRepositoryClient {
  constructor(model) { this.model = model }
  enqueue(data, { transaction } = {}) {
    return this.model.findOne({
      where: { bucket: data.bucket, object_key: data.object_key, status: { [Op.in]: ['PENDING', 'PROCESSING', 'RETRY', 'BLOCKED'] } },
      transaction, lock: transaction?.LOCK?.UPDATE,
    }).then(job => job ?? this.model.create({ ...data, status: 'PENDING', attempts: 0 }, { transaction }))
  }
  async claimBatch({ workerId, limit = 25, now = new Date() } = {}) {
    return this.model.sequelize.transaction(async transaction => {
      const jobs = await this.model.findAll({
        where: { status: { [Op.in]: ['PENDING', 'RETRY'] }, next_attempt_at: { [Op.lte]: now } },
        order: [['next_attempt_at', 'ASC'], ['created_at', 'ASC'], ['id', 'ASC']],
        limit, lock: transaction.LOCK.UPDATE, skipLocked: true, transaction,
      })
      for (const job of jobs) await job.update({ status: 'PROCESSING', locked_at: now, locked_by: workerId, attempts: job.attempts + 1 }, { transaction })
      return jobs
    })
  }

  async recoverExpired({ leaseTimeoutMs = 5 * 60 * 1000, now = new Date() } = {}) {
    const expiredBefore = new Date(now.getTime() - leaseTimeoutMs)
    return this.model.update({ status: 'RETRY', locked_at: null, locked_by: null, next_attempt_at: now }, {
      where: { status: 'PROCESSING', locked_at: { [Op.lt]: expiredBefore } },
    })
  }

  async complete(id, { transaction } = {}) {
    return this.model.update({ status: 'DONE', processed_at: new Date(), locked_at: null, locked_by: null, last_error: null }, {
      where: { id, status: 'PROCESSING' }, transaction,
    })
  }

  async block(id, reason, { transaction } = {}) {
    return this.model.update({ status: 'BLOCKED', last_error: String(reason).slice(0, 4000), locked_at: null, locked_by: null }, {
      where: { id, status: 'PROCESSING' }, transaction,
    })
  }

  async retry(id, error, { nextAttemptAt, transaction } = {}) {
    return this.model.update({ status: 'RETRY', last_error: String(error).slice(0, 4000), next_attempt_at: nextAttemptAt, locked_at: null, locked_by: null }, {
      where: { id, status: 'PROCESSING' }, transaction,
    })
  }

  async withObjectLock(object, callback) {
    return this.model.sequelize.transaction(async transaction => {
      await this.model.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:objectKey, 0))', {
        replacements: { objectKey: `${object.bucket}/${object.objectName}` }, transaction,
      })
      return callback(transaction)
    })
  }
}

export default new MinioCleanupJobRepositoryClient(MinioCleanupJob)