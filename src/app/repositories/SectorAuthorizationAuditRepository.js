import SectorAuthorizationAudit from '../models/SectorAuthorizationAudit.js'

class SectorAuthorizationAuditRepository {
  create(entry, options = {}) {
    return SectorAuthorizationAudit.create(entry, options)
  }
}

export default new SectorAuthorizationAuditRepository()