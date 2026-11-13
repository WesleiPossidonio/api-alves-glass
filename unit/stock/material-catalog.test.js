import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidDecimal, MATERIAL_UNIT_SCALES, normalizeName } from '../../src/app/services/materialQuantities.js'
import MaterialCategoryRepository from '../../src/app/repositories/MaterialCategoryRepository.js'
import MaterialRepository from '../../src/app/repositories/MaterialRepository.js'
import MaterialBalanceRepository from '../../src/app/repositories/MaterialBalanceRepository.js'
import InventoryEventRepository from '../../src/app/repositories/InventoryEventRepository.js'
import WarehouseRepository from '../../src/app/repositories/WarehouseRepository.js'
import UserSectorRepository from '../../src/app/repositories/UserSectorRepository.js'
import Database from '../../src/database/index.js'
import MaterialCatalogService from '../../src/app/services/MaterialCatalogService.js'

test('material quantities validate decimal strings exactly according to approved unit scales', () => {
  assert.deepEqual(MATERIAL_UNIT_SCALES, { un: 0, kg: 3, g: 3, m: 3, cm: 3, L: 3, mL: 3, 'm²': 3 })
  assert.equal(isValidDecimal('2', 0), true)
  assert.equal(isValidDecimal('2.000', 0), false)
  assert.equal(isValidDecimal('0.125', 3), true)
  assert.equal(isValidDecimal('0.0001', 3), false)
  assert.equal(isValidDecimal('-1', 3), false)
  assert.equal(isValidDecimal('1e3', 3), false)
  assert.equal(isValidDecimal('900719925474099312345.123', 3), true)
  assert.equal(normalizeName('  Ferragens  '), 'Ferragens')
})

test('category and subcategory operations are scoped and never expose hard-delete', async () => {
  const originals = {
    warehouse: WarehouseRepository.findById,
    grants: UserSectorRepository.findSectorIdsByUser,
    category: MaterialCategoryRepository.findCategory,
    createMaterial: MaterialRepository.create,
    createBalance: MaterialBalanceRepository.create,
    createEvent: InventoryEventRepository.create,
    transaction: Database.connection.transaction,
    createCategory: MaterialCategoryRepository.createCategory,
    findSubs: MaterialCategoryRepository.findSubcategories,
    createSub: MaterialCategoryRepository.createSubcategory,
  }
  try {
    WarehouseRepository.findById = async id => id === 'w1' ? { id, sector_id: 's1' } : null
    UserSectorRepository.findSectorIdsByUser = async () => ['s1']
    MaterialCategoryRepository.createCategory = async data => ({ id: 'c1', ...data })
    MaterialCategoryRepository.findCategory = async id => id === 'c1' ? { id, warehouse_id: 'w1', update: async data => Object.assign({ id, warehouse_id: 'w1' }, data) } : null
    MaterialCategoryRepository.findSubcategories = async () => []
    MaterialCategoryRepository.createSubcategory = async data => ({ id: 'sub1', ...data })

    const actor = { id: 'u1', role: 'user' }
    assert.deepEqual(await MaterialCatalogService.createCategory(actor, 'w1', { name: '  Elétrica ' }), { id: 'c1', warehouse_id: 'w1', name: 'Elétrica' })
    assert.deepEqual(await MaterialCatalogService.listCategories(actor, 'w2'), null)
    assert.deepEqual(await MaterialCatalogService.createSubcategory(actor, 'c1', { name: 'Conduítes' }), { id: 'sub1', category_id: 'c1', warehouse_id: 'w1', name: 'Conduítes' })
    assert.equal(Object.hasOwn(MaterialCategoryRepository, 'deleteCategory'), false)
    assert.equal(Object.hasOwn(MaterialCategoryRepository, 'deleteSubcategory'), false)
  } finally {
    Object.assign(WarehouseRepository, { findById: originals.warehouse })
    Object.assign(UserSectorRepository, { findSectorIdsByUser: originals.grants })
    Object.assign(MaterialCategoryRepository, {
      findCategory: originals.category, createCategory: originals.createCategory,
      findSubcategories: originals.findSubs, createSubcategory: originals.createSub,
    })
  }
})

test('material creation rejects foreign category, invalid initial quantity, and payload-supplied balance', async () => {
  const originals = {
    warehouse: WarehouseRepository.findById,
    grants: UserSectorRepository.findSectorIdsByUser,
    category: MaterialCategoryRepository.findCategory,
    transaction: Database.connection.transaction,
    createMaterial: MaterialRepository.create,
    createBalance: MaterialBalanceRepository.create,
    createEvent: InventoryEventRepository.create,
  }
  try {
    WarehouseRepository.findById = async () => ({ id: 'w1', sector_id: 's1' })
    UserSectorRepository.findSectorIdsByUser = async () => ['s1']
    MaterialCategoryRepository.findCategory = async id => id === 'c1' ? { id, warehouse_id: 'w1' } : { id, warehouse_id: 'w2' }
    Database.connection.transaction = async () => { throw new Error('must not write') }
    const actor = { id: 'u1', role: 'user' }
    const base = { code: 'A-1', name: 'Item', category_id: 'c1', unit_code: 'un', min_quantity: '0', initialQuantity: '0' }
    assert.deepEqual(await MaterialCatalogService.createMaterial(actor, 'w1', { ...base, balance: '20' }), { error: 'validation' })
    assert.deepEqual(await MaterialCatalogService.createMaterial(actor, 'w1', { ...base, initialQuantity: '-1' }), { error: 'validation' })
    assert.deepEqual(await MaterialCatalogService.createMaterial(actor, 'w1', { ...base, initialQuantity: '1.1' }), { error: 'validation' })
    assert.deepEqual(await MaterialCatalogService.createMaterial(actor, 'w1', { ...base, initialQuantity: 1 }), { error: 'validation' })
    assert.deepEqual(await MaterialCatalogService.createMaterial(actor, 'w1', { ...base, min_quantity: '0.5' }), { error: 'validation' })
    assert.deepEqual(await MaterialCatalogService.createMaterial(actor, 'w1', { ...base, category_id: 'c2' }), { error: 'notFound' })
  } finally {
    WarehouseRepository.findById = originals.warehouse
    UserSectorRepository.findSectorIdsByUser = originals.grants
    MaterialCategoryRepository.findCategory = originals.category
    Database.connection.transaction = originals.transaction
    MaterialRepository.create = originals.createMaterial
    MaterialBalanceRepository.create = originals.createBalance
    InventoryEventRepository.create = originals.createEvent
  }
})

test('material creation atomically persists material, exact balance and one attributed OPENING for authorized users', async () => {
  const originals = {
    warehouse: WarehouseRepository.findById,
    grants: UserSectorRepository.findSectorIdsByUser,
    category: MaterialCategoryRepository.findCategory,
    transaction: Database.connection.transaction,
    createMaterial: MaterialRepository.create,
    createBalance: MaterialBalanceRepository.create,
    createEvent: InventoryEventRepository.create,
  }
  const calls = []
  const tx = { transactionId: 'catalog-create' }
  try {
    WarehouseRepository.findById = async () => ({ id: 'w1', sector_id: 's1' })
    UserSectorRepository.findSectorIdsByUser = async () => ['s1']
    MaterialCategoryRepository.findCategory = async () => ({ id: 'c1', warehouse_id: 'w1' })
    Database.connection.transaction = async callback => callback(tx)
    MaterialRepository.create = async (data, options) => { calls.push(['material', data, options.transaction]); return { id: `m-${calls.length}`, unit_code: data.unit_code } }
    MaterialBalanceRepository.create = async (data, options) => { calls.push(['balance', data, options.transaction]) }
    InventoryEventRepository.create = async (data, transaction) => { calls.push(['event', data, transaction]) }
    const base = { code: 'A-1', name: ' Item ', category_id: 'c1', unit_code: 'kg', min_quantity: '0', initialQuantity: '9007199254740993.125' }
    const created = await MaterialCatalogService.createMaterial({ id: 'user-1', role: 'user' }, 'w1', base)
    assert.equal(created.id, 'm-1')
    assert.equal(calls.length, 3)
    assert.deepEqual(calls.map(([kind, , transaction]) => [kind, transaction]), [['material', tx], ['balance', tx], ['event', tx]])
    assert.equal(calls[1][1].quantity, '9007199254740993.125')
    assert.equal(calls[2][1].event_type, 'OPENING')
    assert.equal(calls[2][1].delta, '9007199254740993.125')
    assert.equal(calls[2][1].balance_before, '0')
    assert.equal(calls[2][1].balance_after, '9007199254740993.125')
    assert.equal(calls[2][1].performed_by, 'user-1')
    assert.equal(calls[2][1].reason_code, 'INITIAL_STOCK')
    assert.equal(Object.hasOwn(calls[0][1], 'initialQuantity'), false)

    calls.length = 0
    const zeroMaterial = await MaterialCatalogService.createMaterial({ id: 'admin-1', role: 'admin' }, 'w1', { ...base, code: 'A-2', initialQuantity: '0' })
    assert.ok(zeroMaterial)
    assert.equal(calls[1][1].quantity, '0')
    assert.equal(calls[2][1].delta, '0')
    assert.equal(calls[2][1].balance_after, '0')
    assert.equal(calls[2][1].performed_by, 'admin-1')

    const forbiddenOriginal = UserSectorRepository.findSectorIdsByUser
    UserSectorRepository.findSectorIdsByUser = async () => []
    assert.deepEqual(await MaterialCatalogService.createMaterial({ id: 'user-outside', role: 'user' }, 'w1', base), { error: 'notFound' })
    UserSectorRepository.findSectorIdsByUser = forbiddenOriginal
  } finally {
    WarehouseRepository.findById = originals.warehouse
    UserSectorRepository.findSectorIdsByUser = originals.grants
    MaterialCategoryRepository.findCategory = originals.category
    Database.connection.transaction = originals.transaction
    MaterialRepository.create = originals.createMaterial
    MaterialBalanceRepository.create = originals.createBalance
    InventoryEventRepository.create = originals.createEvent
  }
})

test('material creation rolls back as one transaction when balance or OPENING persistence fails', async () => {
  const originals = {
    warehouse: WarehouseRepository.findById,
    grants: UserSectorRepository.findSectorIdsByUser,
    category: MaterialCategoryRepository.findCategory,
    transaction: Database.connection.transaction,
    createMaterial: MaterialRepository.create,
    createBalance: MaterialBalanceRepository.create,
    createEvent: InventoryEventRepository.create,
  }
  const base = { code: 'ROLLBACK-1', name: 'Item', category_id: 'c1', unit_code: 'kg', initialQuantity: '1.250' }
  try {
    WarehouseRepository.findById = async () => ({ id: 'w1', sector_id: 's1' })
    UserSectorRepository.findSectorIdsByUser = async () => ['s1']
    MaterialCategoryRepository.findCategory = async () => ({ id: 'c1', warehouse_id: 'w1' })
    for (const failureAt of ['balance', 'event']) {
      let rolledBack = false
      Database.connection.transaction = async callback => {
        try { return await callback({ rollback() { rolledBack = true } }) }
        catch (error) { rolledBack = true; throw error }
      }
      MaterialRepository.create = async () => ({ id: 'm1', unit_code: 'kg' })
      MaterialBalanceRepository.create = async () => { if (failureAt === 'balance') throw new Error('balance write failed') }
      InventoryEventRepository.create = async () => { if (failureAt === 'event') throw new Error('opening write failed') }
      await assert.rejects(MaterialCatalogService.createMaterial({ id: 'admin-1', role: 'admin' }, 'w1', base), /write failed/)
      assert.equal(rolledBack, true)
    }
  } finally {
    WarehouseRepository.findById = originals.warehouse
    UserSectorRepository.findSectorIdsByUser = originals.grants
    MaterialCategoryRepository.findCategory = originals.category
    Database.connection.transaction = originals.transaction
    MaterialRepository.create = originals.createMaterial
    MaterialBalanceRepository.create = originals.createBalance
    InventoryEventRepository.create = originals.createEvent
  }
})

test('material deactivation is locked and requires an exactly zero canonical balance', async () => {
  const originals = {
    findMaterial: MaterialRepository.findById,
    findMaterialForUpdate: MaterialRepository.findByIdForUpdate,
    findBalance: MaterialBalanceRepository.findByMaterialId,
    findBalanceForUpdate: MaterialBalanceRepository.findByMaterialIdForUpdate,
    warehouse: WarehouseRepository.findById,
    transaction: Database.connection.transaction,
  }
  try {
    const material = { id: 'm1', warehouse_id: 'w1', category_id: 'c1', unit_code: 'un', update: async () => { throw new Error('must not deactivate') } }
    MaterialRepository.findById = async () => material
    MaterialRepository.findByIdForUpdate = async () => material
    MaterialBalanceRepository.findByMaterialId = async () => ({ quantity: '1.000' })
    MaterialBalanceRepository.findByMaterialIdForUpdate = async () => ({ quantity: '1.000' })
    WarehouseRepository.findById = async () => ({ id: 'w1', sector_id: 's1' })
    Database.connection.transaction = async callback => callback({ LOCK: { UPDATE: 'UPDATE' } })
    const result = await MaterialCatalogService.updateMaterial({ id: 'u1', role: 'admin' }, 'm1', { active: false })
    assert.deepEqual(result, { error: 'balanceNotZero' })
  } finally {
    MaterialRepository.findById = originals.findMaterial
    MaterialRepository.findByIdForUpdate = originals.findMaterialForUpdate
    MaterialBalanceRepository.findByMaterialId = originals.findBalance
    MaterialBalanceRepository.findByMaterialIdForUpdate = originals.findBalanceForUpdate
    WarehouseRepository.findById = originals.warehouse
    Database.connection.transaction = originals.transaction
  }
})

test('material balance is NUMERIC and repository deliberately has no update/delete methods', () => {
  assert.equal(Database.models.MaterialBalance.rawAttributes.quantity.type.key, 'DECIMAL')
  assert.equal(typeof MaterialBalanceRepository.update, 'undefined')
  assert.equal(typeof MaterialBalanceRepository.delete, 'undefined')
  assert.equal(typeof MaterialRepository.delete, 'undefined')
})

test('material creation mock models same-code serialization and transactionally rolls back every partial write', async () => {
  const originals = {
    warehouse: WarehouseRepository.findById,
    grants: UserSectorRepository.findSectorIdsByUser,
    category: MaterialCategoryRepository.findCategory,
    transaction: Database.connection.transaction,
    createMaterial: MaterialRepository.create,
    createBalance: MaterialBalanceRepository.create,
    createEvent: InventoryEventRepository.create,
  }
  let committed = { materials: 0, balances: 0, openings: 0 }
  const base = { code: 'RACE-1', name: 'Item', category_id: 'c1', unit_code: 'kg', initialQuantity: '1.250' }
  try {
    WarehouseRepository.findById = async () => ({ id: 'w1', sector_id: 's1' })
    UserSectorRepository.findSectorIdsByUser = async () => ['s1']
    MaterialCategoryRepository.findCategory = async () => ({ id: 'c1', warehouse_id: 'w1' })
    Database.connection.transaction = async callback => {
      const staged = { ...committed }
      try { const result = await callback({ staged }); committed = staged; return result }
      catch (error) { throw error }
    }
    MaterialRepository.create = async (_data, { transaction }) => { transaction.staged.materials++; return { id: 'm-race', unit_code: 'kg' } }
    MaterialBalanceRepository.create = async (_data, { transaction }) => { transaction.staged.balances++ }
    InventoryEventRepository.create = async (_data, transaction) => { transaction.staged.openings++ }
    await MaterialCatalogService.createMaterial({ id: 'admin', role: 'admin' }, 'w1', base)
    assert.deepEqual(committed, { materials: 1, balances: 1, openings: 1 })

    for (const failureAt of ['material', 'balance', 'opening']) {
      committed = { materials: 0, balances: 0, openings: 0 }
      Database.connection.transaction = async callback => {
        const staged = { ...committed }
        try { const result = await callback({ staged }); committed = staged; return result }
        catch (error) { throw error }
      }
      MaterialRepository.create = async (_data, { transaction }) => { transaction.staged.materials++; if (failureAt === 'material') throw new Error('injected material failure'); return { id: 'm-fail', unit_code: 'kg' } }
      MaterialBalanceRepository.create = async (_data, { transaction }) => { transaction.staged.balances++; if (failureAt === 'balance') throw new Error('injected balance failure') }
      InventoryEventRepository.create = async (_data, transaction) => { transaction.staged.openings++; if (failureAt === 'opening') throw new Error('injected opening failure') }
      await assert.rejects(MaterialCatalogService.createMaterial({ id: 'admin', role: 'admin' }, 'w1', { ...base, code: `FAIL-${failureAt}` }), /injected/)
      assert.deepEqual(committed, { materials: 0, balances: 0, openings: 0 })
    }
  } finally {
    WarehouseRepository.findById = originals.warehouse
    UserSectorRepository.findSectorIdsByUser = originals.grants
    MaterialCategoryRepository.findCategory = originals.category
    Database.connection.transaction = originals.transaction
    MaterialRepository.create = originals.createMaterial
    MaterialBalanceRepository.create = originals.createBalance
    InventoryEventRepository.create = originals.createEvent
  }
})

test('material balance primary key and opening partial index guarantee one initial balance and ledger event', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const balanceMigration = fs.readFileSync(path.join(root, 'src/database/migrations/20261112000100-create-materials-and-balances.cjs'), 'utf8')
  const ledgerMigration = fs.readFileSync(path.join(root, 'src/database/migrations/20261113000000-create-inventory-ledger.cjs'), 'utf8')
  assert.match(balanceMigration, /material_id: \{ type: Sequelize\.UUID, primaryKey: true/)
  assert.match(ledgerMigration, /CREATE UNIQUE INDEX inventory_events_one_opening_per_material_uq\s+ON inventory_events \(material_id\) WHERE event_type = 'OPENING'/)
})