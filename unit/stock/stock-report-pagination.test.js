import assert from 'node:assert/strict'
import test from 'node:test'
import InventoryEventRepository from '../../src/app/repositories/InventoryEventRepository.js'
import UserSectorRepository from '../../src/app/repositories/UserSectorRepository.js'
import StockReportService, { decodeCursor, encodeCursor, parseCivilDate, saoPauloMidnight } from '../../src/app/services/StockReportService.js'

const uuid = '00000000-0000-4000-8000-000000000001'

test('civil date parser rejects impossible dates and converts São Paulo midnight to UTC', () => {
  assert.equal(parseCivilDate('2026-02-30'), null)
  assert.equal(parseCivilDate('2026-02-28').iso, '2026-02-28')
  assert.equal(saoPauloMidnight(parseCivilDate('2026-01-01')), '2026-01-01T03:00:00.000Z')
})

test('cursor MAC is opaque, rejects tampering and is bound to actor filters and refreshed grants', async () => {
  const previousSecret = process.env.STOCK_REPORT_CURSOR_SECRET
  process.env.STOCK_REPORT_CURSOR_SECRET = 'unit-test-report-cursor-secret-at-least-32-bytes'
  const originals = { grants: UserSectorRepository.findSectorIdsByUser, page: InventoryEventRepository.findStatementPage }
  const calls = []
  try {
    UserSectorRepository.findSectorIdsByUser = async () => [uuid]
    InventoryEventRepository.findStatementPage = async args => {
      calls.push(args)
      return calls.length === 1
        ? Array.from({ length: 3 }, (_, i) => ({ id: `00000000-0000-4000-8000-00000000000${i + 2}`, occurred_at: `2026-01-02T00:00:0${i}.000Z` }))
        : []
    }
    const actor = { id: uuid, role: 'user' }
    const filters = { from: '2026-01-01', to: '2026-02-01', limit: 2 }
    const first = await StockReportService.statement(actor, filters, { now: () => new Date('2026-02-01T00:00:00Z') })
    assert.equal(first.data.length, 2)
    assert.equal(first.asOf, '2026-02-01T00:00:00.000Z')
    assert.ok(first.nextCursor)
    const payload = decodeCursor(first.nextCursor)
    assert.equal(payload.asOf, first.asOf)
    assert.equal(payload.fingerprint.length, 64)
    assert.deepEqual(calls[0].sectorIds, [uuid])
    assert.equal(calls[0].limit, 3)
    assert.equal(calls[0].from, '2026-01-01T03:00:00.000Z')
    assert.equal(calls[0].to, '2026-02-01T03:00:00.000Z')

    const second = await StockReportService.statement(actor, { ...filters, cursor: first.nextCursor })
    assert.equal(second.asOf, first.asOf)
    assert.equal(calls[1].after.id, first.data[1].id)
    assert.equal(calls[1].asOf, first.asOf)
    assert.deepEqual(await StockReportService.statement(actor, { ...filters, type: 'OUT', cursor: first.nextCursor }), { error: 'validation' })
    const tampered = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith('A') ? 'B' : 'A'}`
    assert.deepEqual(await StockReportService.statement(actor, { ...filters, cursor: tampered }), { error: 'validation' })
    UserSectorRepository.findSectorIdsByUser = async () => []
    assert.deepEqual(await StockReportService.statement(actor, { ...filters, cursor: first.nextCursor }), { data: [], nextCursor: null })
  } finally {
    UserSectorRepository.findSectorIdsByUser = originals.grants
    InventoryEventRepository.findStatementPage = originals.page
    if (previousSecret === undefined) delete process.env.STOCK_REPORT_CURSOR_SECRET
    else process.env.STOCK_REPORT_CURSOR_SECRET = previousSecret
  }
})

test('cursor payload codec rejects altered and malformed payloads', () => {
  const previousSecret = process.env.STOCK_REPORT_CURSOR_SECRET
  process.env.STOCK_REPORT_CURSOR_SECRET = 'unit-test-report-cursor-secret-at-least-32-bytes'
  try {
    const cursor = encodeCursor({ version: 1, id: uuid })
    assert.equal(decodeCursor(cursor).id, uuid)
    assert.equal(decodeCursor(`${cursor}.extra`), null)
  } finally {
    if (previousSecret === undefined) delete process.env.STOCK_REPORT_CURSOR_SECRET
    else process.env.STOCK_REPORT_CURSOR_SECRET = previousSecret
  }
})

test('cursor signing fails closed when secret is missing or shorter than 32 bytes', () => {
  const previousSecret = process.env.STOCK_REPORT_CURSOR_SECRET
  try {
    delete process.env.STOCK_REPORT_CURSOR_SECRET
    assert.throws(() => encodeCursor({ version: 1 }), /STOCK_REPORT_CURSOR_SECRET/)
    process.env.STOCK_REPORT_CURSOR_SECRET = 'too-short'
    assert.throws(() => encodeCursor({ version: 1 }), /at least 32 bytes/)
  } finally {
    if (previousSecret === undefined) delete process.env.STOCK_REPORT_CURSOR_SECRET
    else process.env.STOCK_REPORT_CURSOR_SECRET = previousSecret
  }
})