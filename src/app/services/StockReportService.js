import { createHmac, timingSafeEqual } from 'node:crypto'
import InventoryEventRepository from '../repositories/InventoryEventRepository.js'
import UserSectorRepository from '../repositories/UserSectorRepository.js'
import InventoryProjectionService from './InventoryProjectionService.js'

const PAGE_DEFAULT = 25
const PAGE_MAX = 100
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACTORS = ['withdrawnBy', 'receivedBy', 'performedBy', 'authorizedBy']

function parseCivilDate(value) {
  if (typeof value !== 'string') return null
  const match = DATE_RE.exec(value)
  if (!match) return null
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return { year, month, day, iso: value }
}

function saoPauloMidnight({ year, month, day }) {
  // São Paulo's civil offset at midnight. Current tzdata defines UTC-03:00; resolving through
  // Intl keeps the conversion correct if the IANA rules change in a future tzdata release.
  const guess = Date.UTC(year, month - 1, day, 3)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(guess))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  const displayedUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second))
  const targetUtc = Date.UTC(year, month - 1, day)
  return new Date(guess + targetUtc - displayedUtc).toISOString()
}

function addCivilMonths(date, months) {
  const total = date.year * 12 + date.month - 1 + months
  const year = Math.floor(total / 12); const month = total % 12 + 1
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const day = Math.min(date.day, lastDay)
  return { year, month, day, iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` }
}

function signingSecret() {
  const secret = process.env.STOCK_REPORT_CURSOR_SECRET
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('STOCK_REPORT_CURSOR_SECRET must contain at least 32 bytes')
  return secret
}

function sign(value) { return createHmac('sha256', signingSecret()).update(value).digest() }
function encodeCursor(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(body).toString('base64url')}`
}
function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length > 4096) return null
  const [body, signature, extra] = cursor.split('.')
  if (!body || !signature || extra !== undefined) return null
  let actual
  try { actual = Buffer.from(signature, 'base64url') } catch { return null }
  const expected = sign(body)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return null }
}

function filterFingerprint(filters, sectorIds) {
  const normalized = {
    from: filters.from, to: filters.to, warehouseId: filters.warehouseId ?? null,
    materialId: filters.materialId ?? null, sectorId: filters.sectorId ?? null,
    actors: Object.fromEntries(ACTORS.map(key => [key, filters[key] ?? null])),
    type: filters.type ?? null, order: 'occurred_at:desc,id:desc', scope: [...(sectorIds ?? [])].sort(),
  }
  return createHmac('sha256', signingSecret()).update(JSON.stringify(normalized)).digest('hex')
}

function validateFilters(filters, { paginated = false } = {}) {
  if (!filters || !parseCivilDate(filters.from) || !parseCivilDate(filters.to)) return null
  const from = parseCivilDate(filters.from); const to = parseCivilDate(filters.to)
  if (from.iso >= to.iso) return null
  if (to.iso > addCivilMonths(from, 12).iso) return null
  for (const key of ['warehouseId', 'materialId', 'sectorId', ...ACTORS]) {
    if (filters[key] !== undefined && (typeof filters[key] !== 'string' || !UUID_RE.test(filters[key]))) return null
  }
  if (filters.type !== undefined && !['OPENING', 'IN', 'OUT', 'RETURN', 'ADJUSTMENT'].includes(filters.type)) return null
  if (paginated && filters.limit !== undefined && (!Number.isInteger(Number(filters.limit)) || Number(filters.limit) < 1 || Number(filters.limit) > PAGE_MAX)) return null
  if (filters.cursor !== undefined && (typeof filters.cursor !== 'string' || filters.cursor.length > 4096)) return null
  return {
    from, to, fromUtc: saoPauloMidnight(from), toUtc: saoPauloMidnight(to),
    limit: paginated ? Number(filters.limit ?? PAGE_DEFAULT) : undefined,
  }
}

class StockReportService {
  async authorizedScope(actor, filters, transaction) {
    if (actor.role === 'admin') return filters.sectorId ? [filters.sectorId] : null
    const grants = await UserSectorRepository.findSectorIdsByUser(actor.id, { transaction })
    if (!grants.length || (filters.sectorId && !grants.includes(filters.sectorId))) return []
    return filters.sectorId ? [filters.sectorId] : grants
  }

  async summarize(actor, filters, { transaction } = {}) {
    if (!actor?.id || !['admin', 'user'].includes(actor.role)) return { error: 'forbidden' }
    if (filters?.limit !== undefined || filters?.cursor !== undefined || filters?.type !== undefined || ACTORS.some(key => filters?.[key] !== undefined)) return { error: 'validation' }
    const parsed = validateFilters(filters)
    if (!parsed) return { error: 'validation' }
    const sectorIds = await this.authorizedScope(actor, filters, transaction)
    if (sectorIds?.length === 0) return []
    return InventoryEventRepository.summarizeByPeriod({
      from: parsed.fromUtc, to: parsed.toUtc, warehouseId: filters.warehouseId,
      materialId: filters.materialId, sectorIds,
      transaction,
    })
  }

  async statement(actor, filters, { transaction, now = () => new Date() } = {}) {
    if (!actor?.id || !['admin', 'user'].includes(actor.role)) return { error: 'forbidden' }
    const parsed = validateFilters(filters, { paginated: true })
    if (!parsed) return { error: 'validation' }
    const sectorIds = await this.authorizedScope(actor, filters, transaction)
    if (sectorIds?.length === 0) return { data: [], nextCursor: null }
    const fingerprint = filterFingerprint(filters, sectorIds)
    const cursorData = filters.cursor ? decodeCursor(filters.cursor) : null
    if (filters.cursor && (!cursorData || cursorData.version !== 1 || cursorData.fingerprint !== fingerprint ||
      typeof cursorData.asOf !== 'string' || !Number.isFinite(Date.parse(cursorData.asOf)) ||
      typeof cursorData.occurredAt !== 'string' || !Number.isFinite(Date.parse(cursorData.occurredAt)) ||
      typeof cursorData.id !== 'string' || !UUID_RE.test(cursorData.id))) return { error: 'validation' }
    const asOf = cursorData?.asOf ?? now().toISOString()
    // Keep PostgreSQL as the canonical report source; hydrate matching display fields from projections.
    const rows = await InventoryEventRepository.findStatementPage({
      from: parsed.fromUtc, to: parsed.toUtc, asOf, warehouseId: filters.warehouseId,
      materialId: filters.materialId, sectorIds, actors: Object.fromEntries(ACTORS.map(key => [key, filters[key]])),
      type: filters.type, after: cursorData ? { occurredAt: cursorData.occurredAt, id: cursorData.id } : null,
      limit: parsed.limit + 1, transaction,
    })
    const hasMore = rows.length > parsed.limit
    const data = rows.slice(0, parsed.limit)
    const projectionByMaterial = new Map()
    if (data.length) {
      const materialIds = [...new Set(data.map(row => row.material_id))]
      for (const materialId of materialIds) {
        const materialRows = data.filter(row => row.material_id === materialId)
        const readModel = await InventoryProjectionService.getMaterialReadModel(materialId, {
          actor,
          limit: PAGE_MAX,
        })
        const pageVersion = Math.max(...materialRows.map(row => Number(row.sequence)))
        if (readModel && Number(readModel.lastEventVersion) >= pageVersion) {
          projectionByMaterial.set(materialId, new Map(readModel.movements.map(item => [item.eventId, item])))
        }
      }
    }
    const resultData = data.map(row => {
      const projected = projectionByMaterial.get(row.material_id)?.get(row.id)
      if (!projected) return row
      return {
        ...row,
        performed_by: projected.performedBy?.id ?? row.performed_by ?? null,
        received_by: projected.receivedBy?.id ?? row.received_by ?? null,
        withdrawn_by: projected.withdrawnBy?.id ?? row.withdrawn_by ?? null,
        authorized_by: projected.authorizedBy?.id ?? row.authorized_by ?? null,
      }
    })
    const last = data.at(-1)
    const nextCursor = hasMore && last ? encodeCursor({ version: 1, fingerprint, asOf, occurredAt: new Date(last.occurred_at).toISOString(), id: last.id }) : null
    return { data: resultData, nextCursor, asOf }
  }
}

export { PAGE_DEFAULT, PAGE_MAX, parseCivilDate, saoPauloMidnight, encodeCursor, decodeCursor }
export default new StockReportService()