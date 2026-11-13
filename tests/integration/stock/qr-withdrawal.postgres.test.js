import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { randomInt, randomUUID } from 'node:crypto'
import Database from '../../../src/database/index.js'
import PinCredentialService from '../../../src/app/services/PinCredentialService.js'
import QrStockService from '../../../src/app/services/QrStockService.js'
import QrMaterialRepository from '../../../src/app/repositories/QrMaterialRepository.js'
import { hashPin, pinLookupDigest } from '../../../src/app/services/pinSecurity.js'
import app from '../../../src/app.js'

const enabled = process.env.RUN_POSTGRES_STOCK_INTEGRATION === '1'

function assertIsolatedTarget() {
  assert.equal(process.env.DB_HOST, '127.0.0.1')
  assert.equal(process.env.DB_PORT, '5434')
  assert.equal(process.env.DB_DATABASE, 'alvesglass_test')
}

test('PIN QR withdrawal PostgreSQL: throttling, authorization, idempotency, concurrency and append-only ledger', { skip: !enabled }, async () => {
  assertIsolatedTarget()
  process.env.PIN_LOOKUP_SECRET ||= 'postgres-integration-pin-lookup-secret-32-bytes-minimum'
  const admin = new pg.Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE })
  await admin.connect()
  const identity = await admin.query('SELECT current_database() database, version() version')
  assert.equal(identity.rows[0].database, 'alvesglass_test')
  assert.match(identity.rows[0].version, /PostgreSQL 17\.11/)
  const sector = (await admin.query("SELECT id FROM sectors WHERE code='VIDRACARIA' LIMIT 1")).rows[0]?.id
  assert.ok(sector)
  const id = { user: randomUUID(), warehouse: randomUUID(), category: randomUUID(), material: randomUUID(), admin: randomUUID() }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 15)
  const pin = String(randomInt(100000, 1000000))
  const lookup = pinLookupDigest(pin)
  const hash = await hashPin(pin)
  const token = `qr-integration-token-${randomUUID()}`
  const tokenHash = (await import('../../../src/app/services/pinSecurity.js')).tokenDigest(token)
  const operationId = randomUUID()
  const key = `qr-int-${randomUUID()}`
  let server
  try {
    await Database.connection.authenticate()
    const sectorModel = await Database.models.Sector.findOne({ where: { id: sector } })
    assert.ok(sectorModel, 'sector model query must be operational')
    const associationNames = Object.keys(Database.models.Material.associations)
    assert.ok(associationNames.includes('warehouse'), `Material associations: ${associationNames.join(',')}`)
    await admin.query('BEGIN')
    await admin.query(`INSERT INTO users(id,name,email,password_hash,role,status_users,update_number,pin_hash,pin_lookup,created_at,updated_at)
      VALUES($1,$2,$3,'test','user','active','',$4,$5,now(),now()),($6,$7,$8,'test','admin','active','',NULL,NULL,now(),now())`,
    [id.user, `qr-user-${suffix}`, `qr-user-${suffix}@test.invalid`, hash, lookup, id.admin, `qr-admin-${suffix}`, `qr-admin-${suffix}@test.invalid`])
    await admin.query(`INSERT INTO warehouses(id,sector_id,code,name,status,created_at,updated_at) VALUES($1,$2,$3,$4,'ACTIVE',now(),now())`, [id.warehouse, sector, `QR-${suffix}`, `QR ${suffix}`])
    await admin.query(`INSERT INTO user_sectors(user_id,sector_id,granted_by,created_at) VALUES($1,$2,$3,now())`, [id.user, sector, id.admin])
    await admin.query(`INSERT INTO material_categories(id,warehouse_id,name,created_at,updated_at) VALUES($1,$2,$3,now(),now())`, [id.category, id.warehouse, `QR category ${suffix}`])
    await admin.query(`INSERT INTO materials(id,warehouse_id,category_id,code,name,unit_code,min_quantity,active,qr_token_hash,created_at,updated_at)
      VALUES($1,$2,$3,$4,'QR test material','un',0,true,$5,now(),now())`, [id.material, id.warehouse, id.category, `QRM-${suffix}`, tokenHash])
    await admin.query('INSERT INTO material_balances(material_id,quantity,updated_at) VALUES($1,2,now())', [id.material])
    await admin.query("INSERT INTO inventory_events(id,material_id,warehouse_id,event_type,delta,balance_before,balance_after,unit_code_snapshot,description,sequence,performed_by,command_origin,occurred_at) VALUES($4,$1,$2,'OPENING',2,0,2,'un','fixture opening',1,$3,'SESSION',now())", [id.material, id.warehouse, id.admin, randomUUID()])
    await admin.query('COMMIT')

    const directLookup = await admin.query('SELECT id,pin_lookup,pin_revoked_at,status_users,pin_hash IS NOT NULL has_hash FROM users WHERE id=$1', [id.user])
    assert.deepEqual(directLookup.rows[0], { id: id.user, pin_lookup: lookup, pin_revoked_at: null, status_users: 'active', has_hash: true })
    assert.deepEqual(await PinCredentialService.validate(pin, `pin-check-${suffix}`), { id: id.user, role: 'user', pinLookup: lookup })
    const qrFixture = await QrMaterialRepository.findByTokenHash(tokenHash)
    assert.ok(qrFixture, 'eligible active QR must resolve from the PostgreSQL fixture')
    assert.equal(qrFixture.active, true)
    assert.equal(qrFixture.warehouse.status, 'ACTIVE')

    server = app.listen(0)
    await new Promise(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const qrDirect = await QrStockService.resolveForPin(token, pin, `http-pin-${suffix}`)
    assert.ok(qrDirect.material, JSON.stringify(qrDirect))
    assert.equal(qrDirect.material.id, id.material)
    const unauthenticated = await fetch(`${base}/stock/qr/${token}/withdrawal?pin=${pin}`)
    assert.equal(unauthenticated.status, 200, await unauthenticated.clone().text())
    const sessionlessWithdraw = await fetch(`${base}/stock/withdrawals`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `http-${suffix}` },
      body: JSON.stringify({ token, operationId: randomUUID(), quantity: '1', pin }),
    })
    const positiveResponse = await sessionlessWithdraw.clone().json()
    assert.equal(sessionlessWithdraw.status, 201, JSON.stringify(positiveResponse))
    assert.equal(positiveResponse.event?.withdrawn_by, id.user)
    assert.equal(positiveResponse.event?.authorized_by, id.user)
    assert.equal(positiveResponse.event?.command_origin, 'QR')
    assert.equal(positiveResponse.balance, '1')
    const badToken = `invalid-${randomUUID()}`
    const invalidPinResponse = await fetch(`${base}/stock/withdrawals`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `bad-pin-${suffix}` },
      body: JSON.stringify({ token, operationId: randomUUID(), quantity: '1', pin: '000000' }),
    })
    assert.equal(invalidPinResponse.status, 401)
    const invalidQrResponse = await fetch(`${base}/stock/withdrawals`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `invalid-qr-${suffix}` },
      body: JSON.stringify({ token: badToken, operationId: randomUUID(), quantity: '1', pin }),
    })
    assert.equal(invalidQrResponse.status, 401)
    const revokedQrResponse = await fetch(`${base}/stock/withdrawals`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `revoked-qr-${suffix}` },
      body: JSON.stringify({ token: `qr-integration-token-${randomUUID()}`, operationId: randomUUID(), quantity: '1', pin }),
    })
    assert.equal(revokedQrResponse.status, 401)
    const wrongQuantityResponse = await fetch(`${base}/stock/withdrawals`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `bad-quantity-${suffix}` },
      body: JSON.stringify({ token, operationId: randomUUID(), quantity: '99', pin }),
    })
    assert.equal(wrongQuantityResponse.status, 409)
    const publicResponse = await fetch(`${base}/stock/qr/${token}`)
    assert.equal(publicResponse.status, 200)
    assert.deepEqual(Object.keys((await publicResponse.json()).material).sort(), ['image_url', 'name', 'unit_code'])

    const qrRateResults = await Promise.all(Array.from({ length: 10 }, () => QrStockService.resolve('x'.repeat(43), { withBalance: false, ipAddress: `blocked-${suffix}` })))
    assert.equal(qrRateResults.filter(result => result.error === 'rateLimited').length, 5, JSON.stringify(qrRateResults))

    await admin.query('DELETE FROM user_sectors WHERE user_id=$1 AND sector_id=$2', [id.user, sector])
    const denied = await QrStockService.withdraw({ token, pin, ipAddress: `withdraw-${suffix}`, operationId: randomUUID(), idempotencyKey: `denied-${suffix}`, quantity: '1' })
    assert.equal(denied.error, 'notFound')
    await admin.query('INSERT INTO user_sectors(user_id,sector_id,granted_by,created_at) VALUES($1,$2,$3,now())', [id.user, sector, id.admin])

    const intent = { token, pin, ipAddress: `withdraw-${suffix}`, operationId, idempotencyKey: key, quantity: '1' }
    const results = await Promise.all([QrStockService.withdraw(intent), QrStockService.withdraw(intent)])
    assert.equal(results[0].event.id, results[1].event.id)
    const success = results[0]
    assert.equal(success.event?.event_type, 'OUT')
    assert.equal(success.event.performed_by, null)
    assert.equal(success.event.withdrawn_by, id.user)
    assert.equal(success.event.authorized_by, id.user)
    assert.equal(success.event.command_origin, 'QR')
    assert.equal(success.balance, '0')
    const replay = await QrStockService.withdraw(intent)
    assert.equal(replay.event.id, success.event.id)
    const sameOperationNewAuthorizerKey = await QrStockService.withdraw({ ...intent, idempotencyKey: `new-authorizer-key-${suffix}` })
    assert.equal(sameOperationNewAuthorizerKey.error, 'idempotencyConflict')
    await Database.models.Material.update({ qr_token_hash: null, qr_revoked_at: new Date() }, { where: { id: id.material } })
    const revokedTokenRetry = await QrStockService.withdraw(intent)
    assert.equal(revokedTokenRetry.error, 'notFound')

    await Database.models.Material.update({ qr_token_hash: tokenHash, qr_revoked_at: null }, { where: { id: id.material } })
    const revokedPin = String(randomInt(100000, 1000000))
    await PinCredentialService.set({ id: id.admin, role: 'admin' }, id.user, revokedPin)
    await PinCredentialService.revoke({ id: id.admin, role: 'admin' }, id.user)
    const revokedPinResult = await QrStockService.withdraw({ ...intent, pin: revokedPin, operationId: randomUUID(), idempotencyKey: `revoked-pin-${suffix}` })
    assert.equal(revokedPinResult.error, 'invalidPin')

    await PinCredentialService.set({ id: id.admin, role: 'admin' }, id.user, pin, 'RESET', 'Integration PIN restore')

    await admin.query('DELETE FROM user_sectors WHERE user_id=$1 AND sector_id=$2', [id.user, sector])
    const revokedPermissionReplay = await QrStockService.withdraw(intent)
    assert.deepEqual(revokedPermissionReplay, { error: 'notFound' })
    await admin.query('INSERT INTO user_sectors(user_id,sector_id,granted_by,created_at) VALUES($1,$2,$3,now())', [id.user, sector, id.admin])

    const concurrentRevocation = await Promise.all([
      QrStockService.withdraw({ ...intent, operationId: randomUUID(), idempotencyKey: `race-${suffix}` }),
      Database.connection.transaction(async transaction => {
        await Database.connection.query('SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0)) AS locked', { replacements: { scope: `user-sector:${id.user}` }, transaction })
        return Database.models.UserSector.destroy({ where: { user_id: id.user, sector_id: sector }, transaction })
      }),
    ])
    assert.equal(concurrentRevocation[0].error, 'notFound')
    const state = await admin.query('SELECT (SELECT count(*) FROM inventory_events WHERE material_id=$1 AND event_type=$2) outs,(SELECT quantity::text FROM material_balances WHERE material_id=$1) balance', [id.material, 'OUT'])
    assert.deepEqual(state.rows[0], { outs: '2', balance: '0' })
    await assert.rejects(admin.query('UPDATE inventory_events SET description=description WHERE id=$1', [success.event.id]), /append-only/)
    await admin.query('ROLLBACK')
    const rolledBack = await admin.query('SELECT quantity::text AS quantity FROM material_balances WHERE material_id=$1', [id.material])
    assert.equal(rolledBack.rows[0].quantity, '0')

    await PinCredentialService.validate('000000', `bad-pin-${suffix}`)
    const invalidPinRepeated = await Promise.all(Array.from({ length: 5 }, () => PinCredentialService.validate('000000', `blocked-pin-${suffix}`)))
    assert.ok(invalidPinRepeated.every(result => result.error === 'invalidPin'))
    const attempts = await admin.query('SELECT count(*)::int count FROM pin_attempts WHERE scope_hash IS NOT NULL')
    assert.ok(attempts.rows[0].count >= 1)
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    await admin.end()
    await Database.connection.close()
  }
})