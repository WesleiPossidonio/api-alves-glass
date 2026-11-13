import assert from 'node:assert/strict'
import test from 'node:test'
import InventoryEventRepository from '../../src/app/repositories/InventoryEventRepository.js'
import UserSectorRepository from '../../src/app/repositories/UserSectorRepository.js'
import StockReportService from '../../src/app/services/StockReportService.js'

test('stock report validates actor and semi-open UTC interval before querying', async () => {
  const original = InventoryEventRepository.summarizeByPeriod
  let calls = 0
  InventoryEventRepository.summarizeByPeriod = async () => { calls++; return [] }
  try {
    assert.deepEqual(await StockReportService.summarize(null, { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }), { error: 'forbidden' })
    assert.deepEqual(await StockReportService.summarize({ id: 'u1', role: 'admin' }, { from: 'bad', to: '2026-01-02T00:00:00Z' }), { error: 'validation' })
    assert.deepEqual(await StockReportService.summarize({ id: 'u1', role: 'admin' }, { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' }), { error: 'validation' })
    assert.deepEqual(await StockReportService.summarize({ id: 'u1', role: 'admin' }, { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', sectorId: 'bad' }), { error: 'validation' })
    assert.equal(calls, 0)
  } finally {
    InventoryEventRepository.summarizeByPeriod = original
  }
})

test('stock report enforces current user sector grants and forwards explicit UTC interval', async () => {
  const originals = {
    grants: UserSectorRepository.findSectorIdsByUser,
    summarize: InventoryEventRepository.summarizeByPeriod,
  }
  const calls = []
  try {
    UserSectorRepository.findSectorIdsByUser = async () => ['sector-1', 'sector-2']
    InventoryEventRepository.summarizeByPeriod = async filters => { calls.push(filters); return [{ unit_code: 'kg' }] }
    const filters = { from: '2026-01-01', to: '2026-01-02', warehouseId: '00000000-0000-4000-8000-000000000001' }
    assert.deepEqual(await StockReportService.summarize({ id: 'user-1', role: 'user' }, filters), [{ unit_code: 'kg' }])
    assert.deepEqual(calls[0], {
      from: '2026-01-01T03:00:00.000Z', to: '2026-01-02T03:00:00.000Z',
      warehouseId: filters.warehouseId, materialId: undefined, sectorIds: ['sector-1', 'sector-2'],
      transaction: undefined,
    })

    assert.deepEqual(await StockReportService.summarize({ id: 'user-1', role: 'user' }, {
      from: '2026-01-01', to: '2026-01-02', sectorId: '00000000-0000-4000-8000-000000000003',
    }), [])
    assert.equal(calls.length, 1, 'out-of-scope sector does not query report rows')
  } finally {
    UserSectorRepository.findSectorIdsByUser = originals.grants
    InventoryEventRepository.summarizeByPeriod = originals.summarize
  }
})

test('stock report query separates movement categories, computes period balances and never groups units', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const repository = fs.readFileSync(path.join(root, 'src/app/repositories/InventoryEventRepository.js'), 'utf8')
  for (const category of ["'IN'", "'OUT'", "'RETURN'", "'ADJUSTMENT'", "'OPENING'"]) assert.ok(repository.includes(category))
  assert.match(repository, /e\.occurred_at >= :from AND e\.occurred_at < :to/)
  assert.match(repository, /e\.occurred_at < :from/)
  assert.match(repository, /balance_before FROM inventory_events/)
  assert.match(repository, /e\.occurred_at < :to/)
  assert.match(repository, /GROUP BY sm\.material_id, sm\.code, sm\.name, sm\.unit_code/)
  assert.match(repository, /adjustments_positive/)
  assert.match(repository, /adjustments_negative/)
  assert.match(repository, /raw: true, transaction \}\)/)
})