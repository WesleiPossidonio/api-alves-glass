import { Op } from 'sequelize'
import Warehouse from '../models/Warehouse.js'

class WarehouseRepository {
  findById(id, options = {}) {
    return Warehouse.findByPk(id, options)
  }

  findAllForSectors(sectorIds, options = {}) {
    if (!sectorIds.length) return Promise.resolve([])
    return Warehouse.findAll({
      where: { sector_id: { [Op.in]: sectorIds } },
      order: [['sector_id', 'ASC'], ['name', 'ASC']],
      ...options,
    })
  }
}

export default new WarehouseRepository()