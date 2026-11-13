import InventoryEventRepository from '../repositories/InventoryEventRepository.js'
import MaterialRepository from '../repositories/MaterialRepository.js'
import UserSectorRepository from '../repositories/UserSectorRepository.js'
import { cqrsConnections } from '../../config/cqrs.js'

const PAGE_DEFAULT = 25
const PAGE_MAX = 100

export class InventoryProjectionService {
  constructor({ connections = cqrsConnections } = {}) { this.connections = connections }

  async reconcileMaterial(materialId, { repair = false } = {}) {
    const material = await MaterialRepository.findById(materialId)
    if (!material) return { materialId, missingMaterial: true }
    const balanceRow = await import('../repositories/MaterialBalanceRepository.js').then(module => module.default.findByMaterialId(materialId))
    const latest = await InventoryEventRepository.findLatestForMaterial(materialId)
    const db = await this.connections.getMongoDatabase()
    const head = await db.collection('inventory_material_heads').findOne({ _id: materialId })
    const expectedVersion = String(latest?.sequence ?? '0')
    const expectedBalance = String(latest?.balance_after ?? '0')
    const canonicalBalance = String(balanceRow?.quantity ?? '0')
    const matches = String(head?.lastEventVersion ?? '0') === expectedVersion && String(head?.currentBalance ?? '0') === expectedBalance && expectedBalance === canonicalBalance
    const movementCount = await db.collection('inventory_movements').countDocuments({ materialId })
    const ledgerCount = await InventoryEventRepository.countForMaterial(materialId)
    const movementHead = await db.collection('inventory_movements').findOne({ materialId }, { sort: { version: -1 } })
    let movementContentMatches = true
    let movementValuesMatch = !ledgerCount || (String(movementHead?.version ?? 0) === expectedVersion && String(movementHead?.currentBalance) === expectedBalance)
    let afterVersion = '0'
    let movementMembershipMatches = true
    for (;;) {
      const ledgerPage = await InventoryEventRepository.findEventsForRebuild(materialId, afterVersion, undefined, undefined, 500)
      if (!ledgerPage.length) break
      const ids = ledgerPage.map(event => event.id)
      const projected = await db.collection('inventory_movements').find({ materialId, generation: { $exists: false }, eventId: { $in: ids } }).toArray()
      const projectedIds = new Set(projected.map(row => row.eventId))
      if (projectedIds.size !== ids.length) movementMembershipMatches = false
      const ledgerById = new Map(ledgerPage.map(row => [row.id, row]))
      for (const movement of projected) {
        const ledger = ledgerById.get(movement.eventId)
        if (String(movement.currentBalance) !== String(ledger.balance_after) || String(movement.previousBalance) !== String(ledger.balance_before) || String(movement.quantity) !== String(ledger.delta)) movementContentMatches = false
      }
      afterVersion = String(ledgerPage.at(-1).sequence)
    }
    movementValuesMatch = movementValuesMatch && movementContentMatches
    const movementIds = await db.collection('inventory_movements').find({ materialId }, { projection: { _id: 1 } }).toArray()
    for (const movement of movementIds) {
      if (typeof movement._id === 'string' && movement._id.includes(':')) continue
      if (!(await InventoryEventRepository.findById(movement._id))) movementMembershipMatches = false
    }
    const movementsMatch = movementCount === Number(ledgerCount) && movementMembershipMatches
    movementValuesMatch = movementValuesMatch && movementContentMatches
    const movementValuesAreConsistent = movementValuesMatch
    const allMatch = matches && movementsMatch && movementValuesMatch
    if (repair && !allMatch) {
      const rebuilt = await this.rebuildMaterial(materialId)
      return { ...rebuilt, repaired: true, previous: { matches, movementsMatch, movementValuesMatch: movementValuesAreConsistent, movementMembershipMatches } }
    }
    return { materialId, matches, movementsMatch, movementValuesMatch: movementValuesAreConsistent, repaired: false, expectedVersion, expectedBalance, canonicalBalance, movementCount, ledgerCount: Number(ledgerCount) }
  }

  async rebuildMaterial(materialId, { pageSize = PAGE_MAX } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_MAX) throw new Error('pageSize must be between 1 and 100')
    const material = await MaterialRepository.findById(materialId)
    if (!material) throw new Error('material_not_found')
    const snapshot = await this.#snapshotBefore(materialId)
    const db = await this.connections.getMongoDatabase()
    const heads = db.collection('inventory_material_heads')
    const movements = db.collection('inventory_movements')
    const dedupe = db.collection('inventory_event_consumptions')
    const stage = db.collection('inventory_movement_rebuild_stage')
    const ledgerHead = await InventoryEventRepository.findLatestForMaterial(materialId)
    const throughVersion = String(ledgerHead?.sequence ?? '0')
    const generation = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    let after = snapshot.event ? snapshot.version : '0'
    let currentBalance = snapshot.event ? snapshot.balance : '0'
    if (snapshot.event) {
      const entry = this.#movementFromEvent(snapshot.event, material)
      entry._id = `${generation}:${entry.eventId}`
      entry.generation = generation
      await stage.insertOne(entry)
    }
    for (;;) {
      const page = await InventoryEventRepository.findEventsForRebuild(materialId, after, throughVersion, undefined, pageSize)
      if (!page.length) break
      const ops = []
      for (const event of page) {
        const entry = this.#movementFromEvent(event, material)
        currentBalance = entry.currentBalance
        after = String(event.sequence)
        entry._id = `${generation}:${entry.eventId}`
        entry.generation = generation
        ops.push({ insertOne: { document: entry } })
      }
      if (ops.length) await stage.bulkWrite(ops, { ordered: true })
    }
    if (after === '0') {
      const latest = await InventoryEventRepository.findLatestForMaterial(materialId)
      currentBalance = String(latest?.balance_after ?? '0')
      after = String(latest?.sequence ?? '0')
    }
    const version = after
    const head = await heads.findOne({ _id: materialId })
    const currentLedgerHead = await InventoryEventRepository.findLatestForMaterial(materialId)
    if (BigInt(String(currentLedgerHead?.sequence ?? '0')) < BigInt(throughVersion)) {
      await stage.deleteMany({ materialId, generation })
      throw new Error('projection_rebuild_ledger_moved_forward_retry')
    }
    const stagedCount = await stage.countDocuments({ materialId, generation })
    const snapshotMovementCount = snapshot.version !== '0' && stagedCount > 0 ? 1 : 0
    if (stagedCount + snapshotMovementCount !== Number(await InventoryEventRepository.countForMaterial(materialId))) {
      await stage.deleteMany({ materialId, generation })
      throw new Error('projection_rebuild_incomplete_retry')
    }
    let copied = 0
    await movements.deleteMany({ materialId })
    await dedupe.deleteMany({ materialId })
    for await (const row of stage.find({ materialId, generation }).batchSize(500)) {
      const { _id, ...doc } = row
      await movements.insertOne({ _id, ...doc })
      await dedupe.updateOne({ _id: doc.eventId }, { $setOnInsert: { materialId, version: doc.version, consumedAt: new Date() } }, { upsert: true })
      copied += 1
    }
    const snapshotEvent = snapshot.version !== '0' ? await InventoryEventRepository.findByMaterialVersion(materialId, snapshot.version) : null
    if (snapshotEvent) {
      const checkpoint = this.#movementFromEvent(snapshotEvent, material)
      checkpoint._id = checkpoint.eventId
      checkpoint.generation = generation
      await movements.insertOne(checkpoint)
      await dedupe.updateOne({ _id: checkpoint.eventId }, { $setOnInsert: { materialId, version: checkpoint.version, consumedAt: new Date() } }, { upsert: true })
    }
    const expectedMovements = Number(await InventoryEventRepository.countForMaterial(materialId))
    if (copied !== expectedMovements) throw new Error('projection_rebuild_incomplete_retry')
    await stage.deleteMany({ materialId, generation })
    await heads.replaceOne({ _id: materialId }, { _id: materialId, materialId, code: material.code, name: material.name, unit: material.unit_code, currentBalance, lastEventVersion: version, updatedAt: new Date(), generation }, { upsert: true })
    return { materialId, currentBalance, lastEventVersion: version }
  }

  async getMaterialReadModel(materialId, { actor, limit = PAGE_DEFAULT, cursor } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new Error('limit must be between 1 and 100')
    const material = await MaterialRepository.findById(materialId)
    if (!material) return null
    if (!actor?.id || !['admin', 'user'].includes(actor.role)) return null
    const warehouse = await material.getWarehouse?.()
    if (!warehouse) return null
    if (actor.role !== 'admin') {
      const grants = await UserSectorRepository.findSectorIdsByUser(actor.id)
      if (!grants.includes(warehouse.sector_id)) return null
    }
    const db = await this.connections.getMongoDatabase()
    const head = await db.collection('inventory_material_heads').findOne({ _id: materialId })
    const filter = { materialId, ...(head?.generation ? { generation: head.generation } : {}) }
    if (cursor) filter.version = { $lt: String(cursor) }
    const rows = await db.collection('inventory_movements').find(filter, { projection: { generation: 0 } }).sort({ version: -1 }).limit(limit + 1).toArray()
    const more = rows.length > limit
    const page = rows.slice(0, limit)
    return {
      materialId, code: material.code, name: material.name, unit: material.unit_code,
      currentBalance: String(head?.currentBalance ?? '0'), lastEventVersion: Number(head?.lastEventVersion ?? 0),
      movements: page.map(({ generation: _generation, ...movement }) => movement),
      nextCursor: more ? page.at(-1)?.version ?? null : null,
    }
  }

  async #snapshotBefore(materialId) {
    const { default: SnapshotRepository } = await import('../repositories/InventoryEventSnapshotRepository.js')
    const snapshot = await SnapshotRepository.latestValid(materialId)
    if (!snapshot) return { version: '0', balance: '0', event: null }
    return {
      version: String(snapshot.version), balance: String(snapshot.state.balance),
      event: await InventoryEventRepository.findByMaterialVersion(materialId, String(snapshot.version)),
    }
  }

  #movementFromEvent(event, material) {
    const row = typeof event.toJSON === 'function' ? event.toJSON() : event
    return {
      _id: row.id, eventId: row.id, materialId: row.material_id, type: row.event_type,
      material: { id: row.material_id, code: material.code, name: material.name, unit: row.unit_code_snapshot },
      quantity: String(row.delta), previousBalance: String(row.balance_before), currentBalance: String(row.balance_after),
      withdrawnBy: row.withdrawn_by ? { id: row.withdrawn_by } : null,
      authorizedBy: row.authorized_by ? { id: row.authorized_by } : null,
      performedBy: row.performed_by ? { id: row.performed_by } : null,
      receivedBy: row.received_by ? { id: row.received_by } : null,
      reason: row.reason_code ?? null, description: row.description, occurredAt: new Date(row.occurred_at), version: String(row.sequence),
    }
  }
}

export default new InventoryProjectionService()