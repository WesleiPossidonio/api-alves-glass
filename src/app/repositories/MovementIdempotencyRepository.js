import db from '../../database/index.js'

class MovementIdempotencyRepository {
  async findByKey(key, transaction) {
    return db.models.MovementIdempotency.findOne({ where: { idempotency_key: key }, transaction })
  }

  async create(values, transaction) {
    return db.models.MovementIdempotency.create(values, { transaction })
  }
}

export default new MovementIdempotencyRepository()
