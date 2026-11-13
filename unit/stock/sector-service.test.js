import assert from 'node:assert/strict'
import test from 'node:test'
import Database from '../../src/database/index.js'
import SectorRepository from '../../src/app/repositories/SectorRepository.js'
import WarehouseRepository from '../../src/app/repositories/WarehouseRepository.js'
import UserSectorRepository from '../../src/app/repositories/UserSectorRepository.js'
import SectorAuthorizationAuditRepository from '../../src/app/repositories/SectorAuthorizationAuditRepository.js'
import SectorService from '../../src/app/services/SectorService.js'

test('sector listing is scoped to current grants; admin remains global', async () => {
  const originals = {
    sectors: SectorRepository.findAll,
    ids: UserSectorRepository.findSectorIdsByUser,
  }
  try {
    const rows = [{ id: 's1' }, { id: 's2' }]
    SectorRepository.findAll = async options => options?.where ? rows.filter(row => options.where.id.includes(row.id)) : rows
    UserSectorRepository.findSectorIdsByUser = async userId => userId === 'u1' ? ['s2'] : []

    assert.deepEqual(await SectorService.listSectors({ id: 'u1', role: 'user' }), [{ id: 's2' }])
    assert.deepEqual(await SectorService.listSectors({ id: 'u2', role: 'user' }), [])
    assert.deepEqual(await SectorService.listSectors({ id: 'admin', role: 'admin' }), rows)
  } finally {
    SectorRepository.findAll = originals.sectors
    UserSectorRepository.findSectorIdsByUser = originals.ids
  }
})

test('warehouse lookup hides sectors outside a user grant while admin can read globally', async () => {
  const originals = {
    ids: UserSectorRepository.findSectorIdsByUser,
    sector: SectorRepository.findById,
    warehouses: WarehouseRepository.findAllForSectors,
  }
  try {
    UserSectorRepository.findSectorIdsByUser = async () => ['s1']
    SectorRepository.findById = async id => ({ id })
    WarehouseRepository.findAllForSectors = async ids => ids.map(id => ({ id: `w-${id}` }))

    assert.equal(await SectorService.listWarehouses({ id: 'user', role: 'user' }, 's2'), null)
    assert.deepEqual(await SectorService.listWarehouses({ id: 'user', role: 'user' }, 's1'), {
      sector: { id: 's1' }, warehouses: [{ id: 'w-s1' }],
    })
    assert.deepEqual(await SectorService.listWarehouses({ id: 'admin', role: 'admin' }, 's2'), {
      sector: { id: 's2' }, warehouses: [{ id: 'w-s2' }],
    })
  } finally {
    UserSectorRepository.findSectorIdsByUser = originals.ids
    SectorRepository.findById = originals.sector
    WarehouseRepository.findAllForSectors = originals.warehouses
  }
})

test('grant/revoke writes current access and append-only audit atomically, with server-owned actor', async () => {
  const originals = {
    transaction: Database.connection.transaction,
    query: Database.connection.query,
    sector: SectorRepository.findById,
    user: Database.models.User.findByPk,
    grantFind: UserSectorRepository.findGrant,
    grant: UserSectorRepository.grant,
    revoke: UserSectorRepository.revoke,
    audit: SectorAuthorizationAuditRepository.create,
  }
  const calls = []
  const tx = { tx: true, LOCK: { UPDATE: 'UPDATE' } }
  try {
    Database.connection.transaction = callback => callback(tx)
    Database.connection.query = async () => {}
    SectorRepository.findById = async (_id, options) => { assert.equal(options.transaction, tx); return { id: 's1' } }
    Database.models.User.findByPk = async id => ({ id, role: 'user', status_users: 'active' })
    UserSectorRepository.findGrant = async () => null
    UserSectorRepository.grant = async (...args) => calls.push(['grant', ...args])
    UserSectorRepository.revoke = async (...args) => { calls.push(['revoke', ...args]); return 1 }
    SectorAuthorizationAuditRepository.create = async (...args) => calls.push(['audit', ...args])

    assert.deepEqual(await SectorService.grant({ id: 'admin1', role: 'admin' }, 'user1', 's1', 'reason'), { granted: true })
    assert.deepEqual(await SectorService.revoke({ id: 'admin1', role: 'admin' }, 'user1', 's1', 'reason'), { revoked: true })
    const auditEntries = calls.filter(([type]) => type === 'audit')
    assert.deepEqual(auditEntries.map(([, entry]) => entry.action), ['GRANT', 'REVOKE'])
    for (const [, entry, options] of auditEntries) {
      assert.equal(entry.actor_user_id, 'admin1')
      assert.equal(entry.affected_user_id, 'user1')
      assert.equal(entry.sector_id, 's1')
      assert.equal(entry.reason, 'reason')
      assert.equal('occurred_at' in entry, false)
      assert.equal(options.transaction, tx)
    }
    assert.equal(calls.find(([type]) => type === 'grant')[3], 'admin1')
  } finally {
    Database.connection.transaction = originals.transaction
    Database.connection.query = originals.query
    SectorRepository.findById = originals.sector
    Database.models.User.findByPk = originals.user
    UserSectorRepository.findGrant = originals.grantFind
    UserSectorRepository.grant = originals.grant
    UserSectorRepository.revoke = originals.revoke
    SectorAuthorizationAuditRepository.create = originals.audit
  }
})

test('grant/revoke deny non-admin in service and do not start a transaction', async () => {
  const original = Database.connection.transaction
  let started = false
  Database.connection.transaction = async () => { started = true }
  try {
    assert.deepEqual(await SectorService.grant({ id: 'user', role: 'user' }, 'target', 'sector', 'reason'), { forbidden: true })
    assert.deepEqual(await SectorService.revoke({ id: 'user', role: 'user' }, 'target', 'sector', 'reason'), { forbidden: true })
    assert.equal(started, false)
  } finally {
    Database.connection.transaction = original
  }
})