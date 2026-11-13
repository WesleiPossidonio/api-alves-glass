import { createHash } from 'node:crypto'
import InventoryEventRepository from '../repositories/InventoryEventRepository.js'
import InventoryEventSnapshotRepository from '../repositories/InventoryEventSnapshotRepository.js'
import Database from '../../database/index.js'

const positiveInteger = (name, raw) => {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

export function snapshotChecksum(materialId, version, state) {
  return createHash('sha256').update(JSON.stringify({ materialId, version: String(version), state })).digest('hex')
}

export function snapshotInterval(env = process.env) {
  return positiveInteger('INVENTORY_SNAPSHOT_EVENT_INTERVAL', env.INVENTORY_SNAPSHOT_EVENT_INTERVAL ?? '500')
}

export function foldInventoryEvents(events, initialBalance = '0') {
  let balance = BigInt(String(initialBalance).replace('.', ''))
  let scale = (String(initialBalance).split('.')[1] ?? '').length
  let version = 0n
  for (const event of events) {
    const precision = Math.max(scale, (String(event.delta).split('.')[1] ?? '').length)
    if (precision > scale) { balance *= 10n ** BigInt(precision - scale); scale = precision }
    const deltaParts = String(event.delta).split('.')
    let delta = BigInt(deltaParts.join(''))
    const deltaScale = (deltaParts[1] ?? '').length
    if (deltaScale < scale) delta *= 10n ** BigInt(scale - deltaScale)
    if (event.balance_before !== undefined && decimalToUnits(event.balance_before, scale) !== balance) throw new Error('snapshot_replay_balance_mismatch')
    balance += delta
    if (event.balance_after !== undefined && decimalToUnits(event.balance_after, scale) !== balance) throw new Error('snapshot_replay_balance_mismatch')
    version = BigInt(event.sequence)
  }
  return { balance: unitsToDecimal(balance, scale), version: version.toString() }
}

function decimalToUnits(value, scale) {
  const [whole, fraction = ''] = String(value).split('.')
  return BigInt(`${whole}${fraction.padEnd(scale, '0')}`)
}
function unitsToDecimal(value, scale) {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits
  return `${negative ? '-' : ''}${text}`
}

class InventorySnapshotService {
  async createIfDue(materialId, { transaction, every = snapshotInterval(), latestEvent } = {}) {
    const latest = latestEvent ?? await InventoryEventRepository.findLatestForMaterial(materialId, transaction)
    if (!latest || BigInt(latest.sequence) === 0n || BigInt(latest.sequence) % BigInt(every) !== 0n) return null
    const version = String(latest.sequence)
    const state = { balance: String(latest.balance_after), eventType: latest.event_type, occurredAt: new Date(latest.occurred_at).toISOString() }
    const writeSnapshot = async tx => {
    const existing = await InventoryEventSnapshotRepository.findByMaterialVersion(materialId, version, tx)
    if (existing) return existing
    try {
      return await InventoryEventSnapshotRepository.create({
        material_id: materialId,
        version,
        balance: state.balance,
        state,
        checksum: snapshotChecksum(materialId, version, state),
      }, tx)
    } catch (error) {
      if (error.original?.code === '23505' || error.name === 'SequelizeUniqueConstraintError') {
        if (transaction) {
          try {
            const winner = await InventoryEventSnapshotRepository.findByMaterialVersion(materialId, version, transaction)
            if (winner) return winner
          } catch {}
        } else {
          const winner = await InventoryEventSnapshotRepository.findByMaterialVersion(materialId, version)
          if (winner) return winner
        }
      }
      throw error
    }
    }
    return transaction ? writeSnapshot(transaction) : Database.connection.transaction(writeSnapshot)
  }

  async rebuild(materialId, { throughVersion, transaction } = {}) {
    const snapshot = await InventoryEventSnapshotRepository.latestValid(materialId)
    const afterVersion = snapshot ? String(snapshot.version) : '0'
    const baseline = snapshot ? String(snapshot.state.balance) : '0'
    let version = afterVersion
    let balance = baseline
    if (snapshot) {
      const checkpoint = await InventoryEventRepository.findByMaterialVersion(materialId, afterVersion, transaction)
      if (!checkpoint || String(checkpoint.balance_after) !== String(baseline)) {
        version = '0'
        balance = '0'
      }
    }
    for (;;) {
      const events = await InventoryEventRepository.findEventsForRebuild(materialId, version, throughVersion, transaction, 500)
      if (!events.length) break
      const folded = foldInventoryEvents(events, balance)
      balance = folded.balance
      version = folded.version
    }
    return { materialId, balance, version, snapshotVersion: snapshot ? afterVersion : null }
  }
}

export default new InventorySnapshotService()