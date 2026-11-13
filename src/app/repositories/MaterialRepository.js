import Material from '../models/Material.js'

class MaterialRepository {
  findById(id, options = {}) { return Material.findByPk(id, options) }
  findByCode(code, options = {}) { return Material.findOne({ where: { code }, ...options }) }
  findByIdForUpdate(id, transaction) { return Material.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }) }
  findAllForWarehouse(warehouseId, options = {}) { return Material.findAll({ where: { warehouse_id: warehouseId }, order: [['name', 'ASC']], ...options }) }
  create(data, options = {}) { return Material.create(data, options) }
  update(id, data, options = {}) { return Material.update(data, { where: { id }, ...options }) }
}

export default new MaterialRepository()