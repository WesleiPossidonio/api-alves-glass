import UserSector from '../models/UserSector.js'

class UserSectorRepository {
  findSectorIdsByUser(userId, options = {}) {
    return UserSector.findAll({
      attributes: ['sector_id'],
      where: { user_id: userId },
      raw: true,
      ...options,
    }).then(rows => rows.map(row => row.sector_id))
  }

  findGrant(userId, sectorId, options = {}) {
    return UserSector.findOne({ where: { user_id: userId, sector_id: sectorId }, ...options })
  }

  grant(userId, sectorId, actorId, options = {}) {
    return UserSector.create({ user_id: userId, sector_id: sectorId, granted_by: actorId }, options)
  }

  revoke(userId, sectorId, options = {}) {
    return UserSector.destroy({ where: { user_id: userId, sector_id: sectorId }, ...options })
  }
}

export default new UserSectorRepository()