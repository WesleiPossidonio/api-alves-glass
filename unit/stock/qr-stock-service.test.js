import assert from 'node:assert/strict'
import test from 'node:test'
import Database from '../../src/database/index.js'
import QrStockService from '../../src/app/services/QrStockService.js'
import MaterialRepository from '../../src/app/repositories/MaterialRepository.js'
import MaterialBalanceRepository from '../../src/app/repositories/MaterialBalanceRepository.js'
import PinCredentialService from '../../src/app/services/PinCredentialService.js'
import StockMovementService from '../../src/app/services/StockMovementService.js'
import UserSectorRepository from '../../src/app/repositories/UserSectorRepository.js'
import QrPublicRateLimitRepository from '../../src/app/repositories/QrPublicRateLimitRepository.js'

test('public QR resolution returns only the approved catalog fields and never balance or identifiers', async () => {
  const originalQrLookup = (await import('../../src/app/repositories/QrMaterialRepository.js')).default.findByTokenHash
  const originalLimiter = QrPublicRateLimitRepository.consume
  const QrMaterialRepository = (await import('../../src/app/repositories/QrMaterialRepository.js')).default
  const originalWarehouse = Database.models.Warehouse.findByPk
  try {
    QrPublicRateLimitRepository.consume = async () => true
    QrMaterialRepository.findByTokenHash = async () => ({ id: 'material-id', name: 'Bolt', unit_code: 'un', warehouse_id: 'warehouse-id', active: true, warehouse: { id: 'warehouse-id', status: 'ACTIVE' } })
    Database.models.Warehouse.findByPk = async () => ({ status: 'ACTIVE' })
    const result = await QrStockService.resolve('q'.repeat(43), { withBalance: false })
    assert.deepEqual(result, { material: { name: 'Bolt', unit_code: 'un', image_url: null } })
  } finally { QrPublicRateLimitRepository.consume = originalLimiter; QrMaterialRepository.findByTokenHash = originalQrLookup; Database.models.Warehouse.findByPk = originalWarehouse }
})

test('withdrawal uses PIN identity, checks sector before movement, and keeps one stock command', async () => {
  const originals = {
    qrMaterial: Database.models.Material.findOne, warehouse: Database.models.Warehouse.findByPk,
    pin: PinCredentialService.validate, grants: UserSectorRepository.findSectorIdsByUser,
    transaction: Database.connection.transaction, lockedMaterial: MaterialRepository.findByIdForUpdate,
    materialBalanceForUpdate: MaterialBalanceRepository.findByMaterialIdForUpdate,
    move: StockMovementService.move,
  }
  const tx = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } }
  const calls = []
  try {
    MaterialRepository.findById = async id => ({ id, active: true, warehouse_id: 'warehouse-1' })
    Database.models.Material.findOne = async () => ({ id: 'material-id', name: 'Bolt', unit_code: 'un', warehouse_id: 'warehouse-id', active: true, qr_token_hash: 'digest' })
    Database.models.Warehouse.findByPk = async () => ({ id: 'warehouse-1', sector_id: 'sector-1', status: 'ACTIVE' })
    PinCredentialService.validate = async () => ({ id: 'user-1', role: 'user', pinLookup: 'a'.repeat(64) })
    UserSectorRepository.findSectorIdsByUser = async id => { calls.push(['grant', id]); return ['sector-1'] }
    Database.connection.transaction = async callback => callback(tx)
    MaterialRepository.findByIdForUpdate = async (id, transaction) => { assert.equal(transaction, tx); return { id, active: true } }
    MaterialBalanceRepository.findByMaterialIdForUpdate = async () => ({ quantity: '4.000' })
    StockMovementService.move = async (...args) => { calls.push(['move', ...args]); return { event: { event_type: 'OUT' }, balance: '3.5' } }
    const result = await QrStockService.withdraw({ materialId: 'material-1', quantity: '0.5', operationId: '9f8216ab-4014-4c32-870e-15c6cc35cb19', idempotencyKey: 'operation-key', pin: '123456', ipAddress: '203.0.113.3' })
    assert.equal(result.balance, '3.5')
    assert.equal(calls.filter(call => call[0] === 'move').length, 1)
    assert.equal(calls[0][1].pinAuthenticated, true)
    assert.equal(calls[0][3].quantity, '0.5')

    calls.length = 0
  } finally {
    MaterialRepository.findById = originals.material
    Database.models.Material.findOne = originals.qrMaterial
    Database.models.Warehouse.findByPk = originals.warehouse
    PinCredentialService.validate = originals.pin
    UserSectorRepository.findSectorIdsByUser = originals.grants
    Database.connection.transaction = originals.transaction
    MaterialRepository.findByIdForUpdate = originals.lockedMaterial
    MaterialBalanceRepository.findByMaterialIdForUpdate = originals.materialBalanceForUpdate
    StockMovementService.move = originals.move
  }
})