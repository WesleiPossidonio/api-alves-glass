import Database from '../../database/index.js'
import SectorRepository from '../repositories/SectorRepository.js'
import WarehouseRepository from '../repositories/WarehouseRepository.js'
import UserSectorRepository from '../repositories/UserSectorRepository.js'
import SectorAuthorizationAuditRepository from '../repositories/SectorAuthorizationAuditRepository.js'

class SectorService {
  async listSectors(actor) {
    if (actor.role === 'admin') return SectorRepository.findAll()
    const sectorIds = await UserSectorRepository.findSectorIdsByUser(actor.id)
    if (!sectorIds.length) return []
    const sectors = await SectorRepository.findAll({ where: { id: sectorIds } })
    return sectors
  }

  async listWarehouses(actor, sectorId) {
    if (actor.role !== 'admin') {
      const sectorIds = await UserSectorRepository.findSectorIdsByUser(actor.id)
      if (!sectorIds.includes(sectorId)) return null
    }
    const sector = await SectorRepository.findById(sectorId)
    if (!sector) return null
    const warehouses = await WarehouseRepository.findAllForSectors([sectorId])
    return { sector, warehouses }
  }

  async grant(actor, affectedUserId, sectorId, reason) {
    if (actor.role !== 'admin') return { forbidden: true }
    return Database.connection.transaction(async transaction => {
      await Database.connection.query('SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0)) AS locked', { replacements: { scope: `user-sector:${affectedUserId}` }, transaction })
      const [sector, affected] = await Promise.all([
        SectorRepository.findById(sectorId, { transaction }),
        Database.models.User.findByPk(affectedUserId, { transaction }),
      ])
      if (!sector || !affected || affected.role !== 'user' || affected.status_users !== 'active') return { notFound: true }
      const existing = await UserSectorRepository.findGrant(affectedUserId, sectorId, { transaction })
      if (existing) return { unchanged: true }
      await UserSectorRepository.grant(affectedUserId, sectorId, actor.id, { transaction })
      await SectorAuthorizationAuditRepository.create({
        actor_user_id: actor.id,
        affected_user_id: affectedUserId,
        sector_id: sectorId,
        action: 'GRANT',
        reason,
      }, { transaction })
      return { granted: true }
    })
  }

  async revoke(actor, affectedUserId, sectorId, reason) {
    if (actor.role !== 'admin') return { forbidden: true }
    return Database.connection.transaction(async transaction => {
      await Database.connection.query('SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0)) AS locked', { replacements: { scope: `user-sector:${affectedUserId}` }, transaction })
      const [sector, affected] = await Promise.all([
        SectorRepository.findById(sectorId, { transaction }),
        Database.models.User.findByPk(affectedUserId, { transaction }),
      ])
      if (!sector || !affected || affected.role !== 'user') return { notFound: true }
      const removed = await UserSectorRepository.revoke(affectedUserId, sectorId, { transaction })
      if (!removed) return { unchanged: true }
      await SectorAuthorizationAuditRepository.create({
        actor_user_id: actor.id,
        affected_user_id: affectedUserId,
        sector_id: sectorId,
        action: 'REVOKE',
        reason,
      }, { transaction })
      return { revoked: true }
    })
  }
}

export default new SectorService()