import assert from 'node:assert/strict'
import { Sequelize } from 'sequelize'
import test from 'node:test'
import Sector from '../../src/app/models/Sector.js'
import Warehouse from '../../src/app/models/Warehouse.js'
import UserSector from '../../src/app/models/UserSector.js'
import SectorAuthorizationAudit from '../../src/app/models/SectorAuthorizationAudit.js'
import User from '../../src/app/models/User.js'
import Database from '../../src/database/index.js'
import MaterialCategory from '../../src/app/models/MaterialCategory.js'
import MaterialSubcategory from '../../src/app/models/MaterialSubcategory.js'
import Material from '../../src/app/models/Material.js'
import MaterialBalance from '../../src/app/models/MaterialBalance.js'

test('sector foundation models expose explicit tables, constraints, and associations', async () => {
  const sequelize = new Sequelize('postgres://unused:unused@127.0.0.1:1/unused', { logging: false })
  try {
    for (const model of [User, Sector, Warehouse, UserSector, SectorAuthorizationAudit]) model.init(sequelize)
    for (const model of [MaterialCategory, MaterialSubcategory, Material, MaterialBalance]) model.init(sequelize)
    const models = sequelize.models
    for (const model of Object.values(models)) model.associate?.(models)

    assert.equal(Sector.getTableName(), 'sectors')
    assert.equal(Warehouse.getTableName(), 'warehouses')
    assert.equal(Warehouse.rawAttributes.sector_id.allowNull, false)
    assert.equal(Warehouse.rawAttributes.status.defaultValue, 'ACTIVE')
    assert.equal(UserSector.getTableName(), 'user_sectors')
    assert.equal(UserSector.primaryKeyAttributes.length, 2)
    assert.equal(SectorAuthorizationAudit.getTableName(), 'sector_authorization_audits')
    assert.equal(SectorAuthorizationAudit.rawAttributes.reason.allowNull, false)
    assert.deepEqual(SectorAuthorizationAudit.rawAttributes.action.type.values, ['GRANT', 'REVOKE'])
    assert.ok(Warehouse.associations.sector)
    assert.ok(UserSector.associations.user)
    assert.ok(UserSector.associations.sector)
    assert.ok(SectorAuthorizationAudit.associations.actor)
    assert.ok(SectorAuthorizationAudit.associations.affectedUser)
    assert.equal(MaterialCategory.getTableName(), 'material_categories')
    assert.equal(MaterialSubcategory.getTableName(), 'material_subcategories')
    assert.equal(Material.getTableName(), 'materials')
    assert.equal(MaterialBalance.getTableName(), 'material_balances')
    assert.equal(MaterialBalance.rawAttributes.quantity.type.key, 'DECIMAL')
    assert.ok(Material.associations.balance)
    assert.ok(MaterialCategory.associations.subcategories)
  } finally {
    await sequelize.close()
  }
})

test('central database initializer registers each sector-domain model once with its associations', () => {
  const names = Object.keys(Database.models)
  for (const name of ['Sector', 'Warehouse', 'UserSector', 'SectorAuthorizationAudit', 'MaterialCategory', 'MaterialSubcategory', 'Material', 'MaterialBalance', 'InventoryEvent', 'MovementIdempotency']) {
    assert.equal(names.filter(candidate => candidate === name).length, 1)
  }
  assert.ok(Database.models.Sector.associations.warehouses)
  assert.ok(Database.models.Warehouse.associations.sector)
  assert.ok(Database.models.UserSector.associations.user)
  assert.ok(Database.models.SectorAuthorizationAudit.associations.actor)
  assert.ok(Database.models.Material.associations.balance)
})