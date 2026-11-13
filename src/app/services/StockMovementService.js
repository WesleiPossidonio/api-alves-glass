import Database from '../../database/index.js'
import InventoryEventRepository from '../repositories/InventoryEventRepository.js'
import MaterialBalanceRepository from '../repositories/MaterialBalanceRepository.js'
import MaterialRepository from '../repositories/MaterialRepository.js'
import MovementIdempotencyRepository from '../repositories/MovementIdempotencyRepository.js'
import UserSectorRepository from '../repositories/UserSectorRepository.js'
import { addDecimal, formatDecimal, parseDecimal, sha256 } from './stockDecimal.js'
import { MATERIAL_UNIT_SCALES } from './materialQuantities.js'
import { tokenDigest } from './pinSecurity.js'

const conflict = error => ({ error })
class StockCommandError extends Error {
  constructor(code) { super(code); this.code = code }
}
const abort = code => { throw new StockCommandError(code) }
const orderStable = data => JSON.stringify({
  type: data.type,
  materialId: data.materialId,
  warehouseId: data.warehouseId ?? null,
  quantity: data.quantity,
  description: data.description.trim(),
  reasonCode: data.reasonCode ?? null,
  receivedBy: data.receivedBy ?? null,
  originalEventId: data.originalEventId ?? null,
  delta: data.delta ?? null,
})

class StockMovementService {
  async move(actor, materialId, command, idempotencyKey) {
    if (!actor?.id || !['admin', 'user'].includes(actor.role)) return conflict('forbidden')
    const pinWithdrawal = actor.pinAuthenticated === true
    const type = command.type
    if (pinWithdrawal && type !== 'OUT') return conflict('validation')
    if (!['IN', 'OUT', 'RETURN', 'ADJUSTMENT', 'COMPENSATION'].includes(type)) return conflict('validation')
    const isCompensation = type === 'COMPENSATION'
    if ((type === 'ADJUSTMENT' || isCompensation) && actor.role !== 'admin') return conflict('forbidden')
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200) return conflict('validation')
    if (typeof command.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(command.operationId)) return conflict('validation')
    if (typeof command.description !== 'string' || !command.description.trim() || command.description.length > 1000) return conflict('validation')
    if ((type === 'RETURN' || type === 'ADJUSTMENT' || isCompensation) && (typeof command.reasonCode !== 'string' || !command.reasonCode.trim())) return conflict('validation')
    if (isCompensation && (typeof command.originalEventId !== 'string' || !command.originalEventId.trim())) return conflict('validation')

    try { return await Database.connection.transaction(async transaction => {
      if (pinWithdrawal) {
        await Database.connection.query('SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0)) AS locked', { replacements: { scope: `user-pin:${actor.id}` }, transaction })
        const pinOwner = await Database.models.User.findByPk(actor.id, { transaction, lock: transaction.LOCK.KEY_SHARE })
        if (!pinOwner || pinOwner.status_users !== 'active' || pinOwner.pin_revoked_at || pinOwner.pin_lookup !== actor.pinLookup || !pinOwner.pin_hash) abort('notFound')
        const materialForAuthorization = await MaterialRepository.findById(materialId, { transaction })
        if (!materialForAuthorization?.active) abort('notFound')
        if (actor.role !== 'admin') {
          await Database.connection.query('SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0)) AS locked', { replacements: { scope: `user-sector:${actor.id}` }, transaction })
          const warehouseForAuthorization = await Database.models.Warehouse.findByPk(materialForAuthorization.warehouse_id, { transaction })
          const grants = await UserSectorRepository.findSectorIdsByUser(actor.id, { transaction })
          if (!warehouseForAuthorization || warehouseForAuthorization.status !== 'ACTIVE' || !grants.includes(warehouseForAuthorization.sector_id)) abort('notFound')
          if (materialForAuthorization.warehouse_id !== command.warehouseId) abort('notFound')
        }
      }
      if (pinWithdrawal) {
        await Database.connection.query('SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0)) AS locked', { replacements: { scope: `withdrawal-intent:${tokenDigest(`${materialId}:${command.operationId}`)}` }, transaction })
      }
      const material = pinWithdrawal
        ? await MaterialRepository.findByIdForUpdate(materialId, transaction)
        : await MaterialRepository.findById(materialId, { transaction })
      if (!material || !material.active) abort('notFound')
      if (pinWithdrawal && command.qrTokenDigest && material.qr_token_hash !== command.qrTokenDigest) abort('notFound')
      let authorizedWarehouse = null
      if (pinWithdrawal) {
        const lockedWarehouse = await Database.models.Warehouse.findByPk(material.warehouse_id, { transaction, lock: transaction.LOCK.UPDATE })
        if (!lockedWarehouse || lockedWarehouse.status !== 'ACTIVE' || material.warehouse_id !== command.warehouseId) abort('notFound')
        authorizedWarehouse = lockedWarehouse
      } else if (actor.role !== 'admin') {
        const grants = await UserSectorRepository.findSectorIdsByUser(actor.id, { transaction })
        if (!grants.includes(material.warehouse?.sector_id)) {
          const warehouse = await Database.models.Warehouse.findByPk(material.warehouse_id, { transaction })
          if (!warehouse || !grants.includes(warehouse.sector_id)) abort('notFound')
        }
      }
      if (pinWithdrawal && (material.warehouse_id !== command.warehouseId)) abort('notFound')
      if (type === 'IN' && command.receivedBy && actor.role !== 'admin') abort('forbidden')
      const scale = MATERIAL_UNIT_SCALES[material.unit_code]
      const isAdjustment = type === 'ADJUSTMENT'
      let originalEvent = null
      let compensatesEventId = null
      const magnitude = isAdjustment
        ? parseDecimal(command.delta, scale, { signed: true, allowZero: false })
        : isCompensation ? null : parseDecimal(command.quantity, scale, { allowZero: false })
      if (!isCompensation && (!magnitude || (!isAdjustment && command.quantity.startsWith('-')) || (isAdjustment && magnitude.units === 0n))) abort('validation')
      const hash = sha256(orderStable({
        materialId, type, quantity: isAdjustment || isCompensation ? null : formatDecimal(magnitude.units, scale),
        description: command.description, reasonCode: command.reasonCode,
        receivedBy: command.receivedBy, originalEventId: command.originalEventId,
        delta: isAdjustment ? formatDecimal(magnitude.units, scale) : null,
      }))
      const principalType = pinWithdrawal ? 'PIN_AUTHORIZER' : 'USER'
      const principalId = pinWithdrawal ? tokenDigest(`pin-receipt-owner:${actor.pinLookup}`).slice(0, 32) : actor.id
      const existing = await MovementIdempotencyRepository.findByPrincipalKey({
        warehouseId: material.warehouse_id, principalType, principalId, idempotencyKey,
      }, transaction)
      if (existing) {
        if (existing.request_hash !== hash || existing.operation_id !== command.operationId) abort('idempotencyConflict')
        if (pinWithdrawal && type !== 'OUT') abort('idempotencyConflict')
        if (pinWithdrawal && actor.role !== 'admin') {
          const grants = await UserSectorRepository.findSectorIdsByUser(actor.id, { transaction })
          if (!authorizedWarehouse || !grants.includes(authorizedWarehouse.sector_id)) abort('notFound')
        } else if (!pinWithdrawal && actor.role !== 'admin') {
          const grants = await UserSectorRepository.findSectorIdsByUser(actor.id, { transaction })
          const warehouse = await Database.models.Warehouse.findByPk(material.warehouse_id, { transaction })
          if (!warehouse || !grants.includes(warehouse.sector_id)) abort('notFound')
        }
        if (existing.response_body) return existing.response_body
        abort('inProgress')
      }
      const byOperation = await MovementIdempotencyRepository.findByOperationId(material.warehouse_id, command.operationId, transaction)
      if (byOperation) {
        const originalEvent = byOperation.event_id ? await InventoryEventRepository.findById(byOperation.event_id, { transaction }) : null
        abort('idempotencyConflict')
      }

      if (isCompensation) {
        originalEvent = await InventoryEventRepository.findByIdForUpdate(command.originalEventId, transaction)
        if (!originalEvent || originalEvent.material_id !== material.id || !['IN', 'OUT', 'RETURN', 'ADJUSTMENT'].includes(originalEvent.event_type) || originalEvent.compensates_event_id) abort('invalidCompensationReference')
        const originalDelta = parseDecimal(String(originalEvent.delta), scale, { signed: true })
        if (!originalDelta || originalDelta.units === 0n) abort('invalidCompensationReference')
        compensatesEventId = originalEvent.id
      }

      const receipt = await MovementIdempotencyRepository.create({
        warehouse_id: material.warehouse_id,
        operation_id: command.operationId,
        principal_type: principalType, principal_id: principalId,
        idempotency_key: idempotencyKey, request_hash: hash,
      }, transaction)
      if (isCompensation && (await InventoryEventRepository.findCompensations(originalEvent.id, transaction)).length) abort('alreadyCompensated')
      const balance = await MaterialBalanceRepository.findByMaterialIdForUpdate(material.id, transaction)
      if (!balance) abort('balanceMissing')
      const before = parseDecimal(String(balance.quantity), scale)
      if (!before) abort('invalidBalance')
      let returnOfEventId = null
      if (type === 'RETURN') {
        const originalEventId = command.originalEventId ?? null
        if (originalEventId) {
          const original = await InventoryEventRepository.findByIdForUpdate(originalEventId, transaction)
          if (!original || original.event_type !== 'OUT' || original.material_id !== material.id) abort('invalidReturnReference')
          const originalDelta = parseDecimal(String(original.delta), scale, { signed: true })
          if (!originalDelta || originalDelta.units >= 0n) abort('invalidReturnReference')
          const returned = await InventoryEventRepository.findReturnsForUpdate(original.id, transaction)
          const alreadyReturned = returned.reduce((sum, item) => {
            const quantity = parseDecimal(String(item.delta), scale, { allowZero: false })
            return sum + (quantity?.units ?? 0n)
          }, 0n)
          if (alreadyReturned + magnitude.units > -originalDelta.units) abort('returnExceedsOriginal')
          returnOfEventId = original.id
        }
      }
      const delta = isCompensation
        ? { units: -parseDecimal(String(originalEvent.delta), scale, { signed: true }).units, scale }
        : type === 'ADJUSTMENT' || type === 'OUT'
          ? { units: type === 'OUT' ? -magnitude.units : magnitude.units, scale: magnitude.scale }
        : magnitude
      const after = addDecimal(before, delta)
      if (after.units < 0n) abort('insufficientBalance')
      const latest = await InventoryEventRepository.findLatestForMaterial(material.id, transaction)
      const sequence = BigInt(latest?.sequence ?? '0') + 1n
      const event = await InventoryEventRepository.create({
        material_id: material.id, warehouse_id: material.warehouse_id, event_type: isCompensation ? 'ADJUSTMENT' : type,
        delta: formatDecimal(delta.units, scale), balance_before: formatDecimal(before.units, scale),
        balance_after: formatDecimal(after.units, scale), unit_code_snapshot: material.unit_code,
        reason_code: command.reasonCode ?? null, description: command.description.trim(),
        sequence: sequence.toString(), performed_by: pinWithdrawal ? null : actor.id,
        withdrawn_by: pinWithdrawal && type === 'OUT' ? actor.id : null,
        authorized_by: pinWithdrawal && type === 'OUT' ? actor.id : null,
        received_by: command.receivedBy ?? null,
        command_origin: pinWithdrawal ? 'QR' : 'SESSION', return_of_event_id: returnOfEventId, compensates_event_id: compensatesEventId,
      }, transaction)
      await MaterialBalanceRepository.updateQuantity(material.id, formatDecimal(after.units, scale), transaction)
      const result = { event, balance: formatDecimal(after.units, scale), unit: material.unit_code }
      await MovementIdempotencyRepository.complete(receipt.id, { eventId: event.id, responseStatus: 201, responseBody: result }, transaction)
      return result
    }) } catch (error) {
      if (error instanceof StockCommandError) return conflict(error.code)
      if (error.name === 'SequelizeUniqueConstraintError' || error.original?.code === '23505' || error.code === '23505') {
        const constraint = error.original?.constraint ?? error.parent?.constraint ?? error.constraint
        return conflict(isCompensation && constraint === 'inventory_events_one_compensation_per_original_uq' ? 'alreadyCompensated' : 'idempotencyConflict')
      }
      throw error
    }
  }
}

export default new StockMovementService()