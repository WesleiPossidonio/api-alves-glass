import Database from '../../database/index.js'

class QrMaterialRepository {
  findByTokenHash(tokenHash) {
    return Database.models.Material.findOne({
      where: { qr_token_hash: tokenHash, qr_revoked_at: null, active: true },
      attributes: ['id', 'name', 'unit_code', 'warehouse_id', 'qr_token_hash', 'active'],
    }).then(async material => {
      if (!material) return null
      const result = typeof material.toJSON === 'function' ? material.toJSON() : { ...material }
      result.warehouse = await Database.models.Warehouse.findByPk(material.warehouse_id, { attributes: ['id', 'sector_id', 'status'], raw: true })
      return result
    })
  }
}

export default new QrMaterialRepository()