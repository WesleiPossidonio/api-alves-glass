import MaterialBalance from '../models/MaterialBalance.js'

class MaterialBalanceRepository {
  findByMaterialId(materialId, options = {}) { return MaterialBalance.findByPk(materialId, options) }
  findByMaterialIdForUpdate(materialId, transaction) { return MaterialBalance.findByPk(materialId, { transaction, lock: transaction.LOCK.UPDATE }) }
  create(data, options = {}) { return MaterialBalance.create(data, options) }
  updateQuantity(materialId, quantity, transaction) {
    return MaterialBalance.update({ quantity }, { where: { material_id: materialId }, transaction })
  }
}

export default new MaterialBalanceRepository()