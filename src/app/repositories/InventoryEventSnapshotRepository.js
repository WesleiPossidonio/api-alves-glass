import { createHash } from 'node:crypto'
import { Op } from 'sequelize'
import InventoryEventSnapshot from '../models/InventoryEventSnapshot.js'
import InventoryEventRepository from './InventoryEventRepository.js'

class InventoryEventSnapshotRepository {
  create(row, transaction) { return InventoryEventSnapshot.create(row, { transaction }) }
  findByMaterialVersion(materialId, version, transaction) {
    return InventoryEventSnapshot.findOne({ where: { material_id: materialId, version }, transaction })
  }

  async latestValid(materialId) {
    let cursor = null
    for (;;) {
      const rows = await InventoryEventSnapshot.findAll({
        where: cursor ? { material_id: materialId, version: { [Op.lt]: cursor } } : { material_id: materialId },
        order: [['version', 'DESC']], limit: 100,
      })
      if (!rows.length) return null
      for (const row of rows) {
        const canonical = JSON.stringify({ materialId, version: String(row.version), state: row.state })
        if (row.checksum === createHash('sha256').update(canonical).digest('hex') && String(row.balance) === String(row.state?.balance)) {
          const checkpoint = await InventoryEventRepository.findByMaterialVersion(materialId, String(row.version))
          if (checkpoint && String(checkpoint.balance_after) === String(row.state.balance)) return row
        }
      }
      cursor = rows.at(-1).version
      if (rows.length < 100) return null
    }
  }

  async latest(materialId) {
    return InventoryEventSnapshot.findOne({ where: { material_id: materialId }, order: [['version', 'DESC']] })
  }

  checksum(value) {
    return createHash('sha256').update(value).digest('hex')
  }
}

export default new InventoryEventSnapshotRepository()