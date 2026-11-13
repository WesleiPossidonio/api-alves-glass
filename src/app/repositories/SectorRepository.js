import Sector from '../models/Sector.js'

class SectorRepository {
  findAll(options = {}) {
    return Sector.findAll({ order: [['code', 'ASC']], ...options })
  }

  findById(id, options = {}) {
    return Sector.findByPk(id, options)
  }
}

export default new SectorRepository()