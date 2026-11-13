import Database from '../../database/index.js'
import MaterialBalanceRepository from '../repositories/MaterialBalanceRepository.js'
import MaterialRepository from '../repositories/MaterialRepository.js'
import QrMaterialRepository from '../repositories/QrMaterialRepository.js'
import PinCredentialService from './PinCredentialService.js'
import StockMovementService from './StockMovementService.js'
import UserSectorRepository from '../repositories/UserSectorRepository.js'
import { createQrToken, tokenDigest } from './pinSecurity.js'

const unavailable = () => ({ error: 'notFound' })

class QrStockService {
  async issue(actor, materialId) {
    if (actor?.role !== 'admin' || !actor.id) return { error: 'forbidden' }
    const token = createQrToken()
    try {
      return await Database.connection.transaction(async transaction => {
        const material = await MaterialRepository.findByIdForUpdate(materialId, transaction)
        if (!material) return unavailable()
        await material.update({ qr_token_hash: tokenDigest(token), qr_revoked_at: null }, { transaction })
        return { token }
      })
    } catch (error) {
      if (error.original?.code === '23505') return { error: 'conflict' }
      throw error
    }
  }

  async revoke(actor, materialId) {
    if (actor?.role !== 'admin' || !actor.id) return { error: 'forbidden' }
    return Database.connection.transaction(async transaction => {
      const material = await MaterialRepository.findByIdForUpdate(materialId, transaction)
      if (!material) return unavailable()
      await material.update({ qr_token_hash: null, qr_revoked_at: new Date() }, { transaction })
      return { revoked: true }
    })
  }


  async resolve(token, { withBalance = true, ipAddress } = {}) {
    if (!withBalance) {
      try {
        if (!await PinCredentialService.allowPublicResolve(ipAddress)) return { error: 'rateLimited' }
      } catch {
        return { error: 'unavailable' }
      }
    }
    const material = await this.#materialForToken(token)
    if (!material) return unavailable()
    if (!withBalance) return { material: { name: material.name, unit_code: material.unit_code, image_url: null } }
    const balance = await MaterialBalanceRepository.findByMaterialId(material.id)
    return {
      material: { id: material.id, name: material.name, unit_code: material.unit_code, warehouse_id: material.warehouse_id },
      balance: String(balance?.quantity ?? '0'),
    }
  }

  async resolveForPin(token, pin, ipAddress) {
    const pinActor = await PinCredentialService.validate(pin, ipAddress)
    if (pinActor.error) return pinActor
    const material = await this.#materialForToken(token)
    if (!material) return unavailable()
    return this.#resolveWithAuthorization(material, pinActor, { refreshedPin: true, currentPinAlreadyLocked: true })
  }

  async manualResolveByCode(input) {
    const pinActor = await PinCredentialService.validate(input?.pin, input?.ipAddress)
    if (pinActor.error) return pinActor
    const material = await this.#materialForCode(input.code)
    if (!material?.active) return unavailable()
    return this.#resolveWithAuthorization(material, pinActor, { refreshedPin: true, currentPinAlreadyLocked: true })
  }

  async #resolveWithAuthorization(material, pinActor, { refreshedPin = false, currentPinAlreadyLocked = false } = {}) {
    return Database.connection.transaction(async transaction => {
      if (refreshedPin) {
        await Database.connection.query('SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0)) AS locked', { replacements: { scope: `user-pin:${pinActor.id}` }, transaction })
        const currentPinOwner = currentPinAlreadyLocked
          ? await Database.models.User.findByPk(pinActor.id, { transaction, lock: transaction.LOCK.SHARE })
          : await Database.models.User.findByPk(pinActor.id, { transaction, lock: transaction.LOCK.KEY_SHARE })
        if (!currentPinOwner || currentPinOwner.status_users !== 'active' || currentPinOwner.pin_revoked_at || currentPinOwner.pin_lookup !== pinActor.pinLookup || !currentPinOwner.pin_hash) return unavailable()
      }
      const warehouse = await Database.models.Warehouse.findByPk(material.warehouse_id, { transaction, lock: transaction.LOCK.KEY_SHARE })
      const currentMaterial = await MaterialRepository.findByIdForUpdate(material.id, transaction)
      if (!warehouse || warehouse.status !== 'ACTIVE' || !currentMaterial?.active) return unavailable()
      if (pinActor.role !== 'admin') {
        await Database.connection.query('SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0)) AS locked', { replacements: { scope: `user-sector:${pinActor.id}` }, transaction })
        const grants = await UserSectorRepository.findSectorIdsByUser(pinActor.id, { transaction })
        if (!grants.includes(warehouse.sector_id)) return unavailable()
      }
      const balance = await MaterialBalanceRepository.findByMaterialIdForUpdate(material.id, transaction)
      return { material: { id: currentMaterial.id, name: currentMaterial.name, unit_code: currentMaterial.unit_code, warehouse_id: warehouse.id }, balance: String(balance?.quantity ?? '0') }
    })
  }

  async withdraw(input) {
    const references = [input.token, input.materialId, input.code].filter(Boolean)
    if (references.length !== 1) return { error: 'validation' }
    const pinActor = await PinCredentialService.validate(input.pin, input.ipAddress)
    if (pinActor.error) return pinActor
    const material = input.token ? await this.#materialForToken(input.token)
      : input.materialId ? await this.#materialForId(input.materialId)
        : await this.#materialForCode(input.code)
    if (!material?.active) return unavailable()
    return StockMovementService.move({ ...pinActor, pinAuthenticated: true, role: 'user' }, material.id, {
      type: 'OUT', operationId: input.operationId, quantity: input.quantity,
      description: 'Unit stock withdrawal', reasonCode: 'QR_WITHDRAWAL', warehouseId: material.warehouse_id,
      qrTokenDigest: input.token ? tokenDigest(input.token) : null,
    }, input.idempotencyKey)
  }

  async #withBalance(material, warehouseId) {
    const balance = await MaterialBalanceRepository.findByMaterialId(material.id)
    return {
      material: { id: material.id, name: material.name, unit_code: material.unit_code, warehouse_id: warehouseId },
      balance: String(balance?.quantity ?? '0'),
    }
  }

  async #materialForCode(code) {
    if (typeof code !== 'string' || !code.trim() || code.trim().length > 64) return null
    return MaterialRepository.findByCode(code.trim())
  }

  async #materialForToken(token) {
    if (typeof token !== 'string' || token.length < 40 || token.length > 64) return null
    const material = await QrMaterialRepository.findByTokenHash(tokenDigest(token))
    if (!material) return null
    const normalized = typeof material.toJSON === 'function' ? material.toJSON() : material
    normalized.warehouse = await Database.models.Warehouse.findByPk(normalized.warehouse_id, { raw: true })
    return normalized
  }

  async #materialForId(materialId) {
    if (typeof materialId !== 'string') return null
    const material = await MaterialRepository.findById(materialId)
    if (!material?.active) return null
    const warehouse = await Database.models.Warehouse.findByPk(material.warehouse_id)
    return warehouse?.status === 'ACTIVE' ? material : null
  }
}

export default new QrStockService()