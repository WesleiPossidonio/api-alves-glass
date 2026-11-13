import { Op } from 'sequelize'
import MinioUploadIntent from '../models/MinioUploadIntent.js'

// Proposal repository: register only after schema approval and migration application.
export class MinioUploadIntentRepositoryClient {
  constructor(model) { this.model = model }
  create(data, options = {}) { return this.model.create(data, options) }
  markCommitted(id, { transaction } = {}) {
    return this.model.update({ status: 'COMMITTED', completed_at: new Date(), last_error: null }, { where: { id, status: 'UPLOADING' }, transaction })
  }
  renewLease(id, leaseExpiresAt = new Date(Date.now() + 15 * 60 * 1000)) {
    return this.model.update({ lease_expires_at: leaseExpiresAt }, { where: { id, status: 'UPLOADING' } })
  }
  markAbandoned(id, reason) {
    return this.model.update({ status: 'ABANDONED', last_error: String(reason).slice(0, 2000), lease_expires_at: new Date(), completed_at: new Date() }, { where: { id, status: 'UPLOADING' } })
  }
  setObject(id, bucket, objectKey, { transaction } = {}) {
    return this.model.update({ bucket, object_key: objectKey }, { where: { id, status: 'UPLOADING' }, transaction })
  }
  findExpiredUploading({ before = new Date(), limit = 100 } = {}) {
    return this.model.findAll({ where: { status: 'UPLOADING', lease_expires_at: { [Op.lt]: before } }, order: [['lease_expires_at', 'ASC']], limit })
  }
  listKnownObjectKeys({ buckets } = {}) {
    return this.model.findAll({ attributes: ['bucket', 'object_key'], where: buckets ? { bucket: { [Op.in]: buckets } } : {}, raw: true })
      .then(rows => rows.map(row => `${row.bucket}/${row.object_key}`))
  }
}

export default new MinioUploadIntentRepositoryClient(MinioUploadIntent)