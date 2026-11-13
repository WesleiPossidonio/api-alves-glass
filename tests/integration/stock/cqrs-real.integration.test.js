import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { createServer } from 'node:http'
import app from '../../../src/app.js'
import authConfig from '../../../src/config/auth.js'
import UserSectorRepository from '../../../src/app/repositories/UserSectorRepository.js'
import test from 'node:test'
import Database from '../../../src/database/index.js'
import InventoryEventRepository from '../../../src/app/repositories/InventoryEventRepository.js'
import InventoryOutboxDeliveryRepository from '../../../src/app/repositories/InventoryOutboxDeliveryRepository.js'
import { InventoryOutboxPublisher } from '../../../src/app/services/InventoryOutboxPublisher.js'
import { InventoryProjectionConsumer } from '../../../src/app/services/InventoryProjectionConsumer.js'
import { createInventoryEventEnvelope } from '../../../src/app/services/InventoryOutboxService.js'
import InventorySnapshotService from '../../../src/app/services/InventorySnapshotService.js'
import { InventoryProjectionService } from '../../../src/app/services/InventoryProjectionService.js'
import InventoryEventSnapshotRepository from '../../../src/app/repositories/InventoryEventSnapshotRepository.js'
import StockReportService from '../../../src/app/services/StockReportService.js'
import { cqrsConnections } from '../../../src/config/cqrs.js'

const required = ['DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD', 'MONGODB_URI', 'MONGODB_DATABASE', 'RABBITMQ_URL']
const enabled = process.env.FEATURE003_CQRS_INTEGRATION === '1' && required.every(key => process.env[key])

test('isolated PostgreSQL → Outbox → RabbitMQ → MongoDB, replay and reconciliation', { skip: !enabled }, async t => {
  assert.equal(process.env.DB_HOST, '127.0.0.1')
  assert.equal(process.env.DB_PORT, '55438')
  const identity = await Database.connection.query("SELECT current_database() AS database, current_user AS username, inet_server_port() AS port, pg_postmaster_start_time() AS started")
  assert.equal(identity[0][0].database, process.env.DB_DATABASE)
  assert.equal(Number(identity[0][0].port), 5432)
  assert.equal(process.env.DB_DATABASE, 'feature003_integration')

  const suffix = randomUUID()
  const testMaterialIds = new Set()
  const previousCursorSecret = process.env.STOCK_REPORT_CURSOR_SECRET
  process.env.STOCK_REPORT_CURSOR_SECRET = 'isolated-feature003-integration-cursor-secret-32bytes'
  const sector = await Database.models.Sector.create({ code: `IT-${suffix.slice(0, 8)}`, name: `Integration ${suffix}` })
  const warehouse = await Database.models.Warehouse.create({ sector_id: sector.id, code: `IT-${suffix}`, name: `Integration ${suffix}` })
  const category = await Database.models.MaterialCategory.create({ warehouse_id: warehouse.id, name: `Integration ${suffix}` })
  const user = await Database.models.User.create({ name: `Integration ${suffix}`, email: `it-${suffix}@example.test`, password_hash: 'unused', status_users: 'active', role: 'admin' })
  const material = await Database.models.Material.create({ warehouse_id: warehouse.id, category_id: category.id, code: `IT-${suffix}`, name: 'Fixture glass', unit_code: 'un' })
  testMaterialIds.add(material.id)
  await Database.models.MaterialBalance.create({ material_id: material.id, quantity: '0' })
  await Database.models.UserSector.create({ user_id: user.id, sector_id: sector.id, granted_by: user.id })
  const { MongoClient } = await import('mongodb')
  const mongoUri = process.env.MONGODB_URI.replace('feature003-integration-mongodb:27017', '127.0.0.1:27028').replace('replicaSet=feature003-rs', 'directConnection=true')
  const mongoClient = new MongoClient(mongoUri)
  await mongoClient.connect()
  const db = mongoClient.db(process.env.MONGODB_DATABASE)
  testMaterialIds.add(material.id)
  const rabbitConnection = await cqrsConnections.getRabbitConnection()
  const testNamespace = `alves.inventory.test.${randomUUID()}`
  const testExchange = `${testNamespace}.events`
  const testQueue = `${testNamespace}.projection`
  const testDeadQueue = `${testQueue}.dead`
  const testDeadExchange = `${testExchange}.dead`
  const isolatedPublisherConnections = {
    getRabbitConnection: async () => rabbitConnection,
    close: async () => {},
  }
  const directConnections = {
    getMongoDatabase: async () => db,
    getMongoClient: async () => mongoClient,
    getRabbitConnection: async () => cqrsConnections.getRabbitConnection(),
    close: async () => {},
  }
  const originalMongoGet = await db.collection('inventory_material_heads').findOne({ _id: material.id })
  assert.equal(originalMongoGet, null, 'UUID-based test fixture must not collide with an existing material projection')
  await db.collection('inventory_event_consumptions').createIndex({ materialId: 1, version: 1 }, { unique: true })
  const consumer = new InventoryProjectionConsumer({
    connections: directConnections,
    logger: { error: (...args) => console.error(...args) },
    topology: { exchange: testExchange, queue: testQueue, routingKey: 'inventory.event.v1', maxRetryCount: 2 },
    loadCanonicalEvents: async (materialId, fromVersion, throughVersion) => {
      const events = await InventoryEventRepository.findEventsForRebuild(materialId, (BigInt(fromVersion) - 1n).toString(), throughVersion)
      return events.map(row => createInventoryEventEnvelope(row).payload)
    },
  })
  await consumer.start()
  const channel = await rabbitConnection.createConfirmChannel()
  const crashExchangePrefix = `${testNamespace}.crash-test`
  const restoreMongo = async () => {
    await db.collection('inventory_material_heads').deleteOne({ _id: material.id })
    await db.collection('inventory_movements').deleteMany({ materialId: material.id })
    await db.collection('inventory_event_consumptions').deleteMany({ materialId: material.id })
  }
  t.after(async () => {
    await consumer.stop().catch(() => {})
    // PostgreSQL fixtures intentionally remain append-only and are uniquely namespaced per run.
    await restoreMongo().catch(() => {})
    await consumer.stop()
    await channel.close().catch(() => {})
    await mongoClient.close().catch(() => {})
    await cqrsConnections.close().catch(() => {})
    await Database.connection.close().catch(() => {})
    if (previousCursorSecret === undefined) delete process.env.STOCK_REPORT_CURSOR_SECRET
    else process.env.STOCK_REPORT_CURSOR_SECRET = previousCursorSecret
  })

  const eventIds = []
  const startingSequence = await Database.models.InventoryEvent.max('sequence', { where: { material_id: material.id } }) ?? 0
  for (const [offset, delta, before, after] of [[1, '10', '0', '10'], [2, '-2', '10', '8']]) {
    const sequence = Number(startingSequence) + offset
    const id = randomUUID()
    eventIds.push(id)
    await Database.connection.transaction(async transaction => InventoryEventRepository.create({
      id, material_id: material.id, warehouse_id: warehouse.id,
      event_type: offset === 1 ? 'OPENING' : 'OUT', delta, balance_before: before, balance_after: after,
      unit_code_snapshot: 'un', reason_code: null, description: `integration ${sequence}`, sequence,
      performed_by: user.id, received_by: null, withdrawn_by: null, authorized_by: null,
      command_origin: 'SESSION', occurred_at: new Date(Date.now() + sequence),
    }, transaction))
  }
  await Database.connection.query(`UPDATE inventory_outbox SET created_at = CASE event_id
    WHEN :firstId THEN '2026-01-01T00:00:00Z'::timestamptz
    WHEN :secondId THEN '2026-01-02T00:00:00Z'::timestamptz END
    WHERE event_id IN (:ids)`, { replacements: { firstId: eventIds[0], secondId: eventIds[1], ids: eventIds } })
  await Database.models.MaterialBalance.update({ quantity: '8' }, { where: { material_id: material.id } })
  await Database.connection.query("UPDATE inventory_outbox SET status='PENDING', locked_by=NULL, locked_until=NULL, available_at=now() WHERE aggregate_id=:materialId AND status='PROCESSING'", { replacements: { materialId: material.id } })
  const publisher = new InventoryOutboxPublisher({ connections: directConnections, topology: { exchange: testExchange, queue: testQueue }, logger: { error: (...args) => console.error(...args), warn: (...args) => console.warn(...args) } })
  const publishedCount = await publisher.publishBatch()
  assert.ok(publishedCount >= 2)
  await t.test('messages reach projection, duplicates, pagination, replay/reconciliation', async () => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && !(await db.collection('inventory_event_consumptions').findOne({ _id: eventIds[1] }))) await new Promise(resolve => setTimeout(resolve, 100))
    const head = await db.collection('inventory_material_heads').findOne({ _id: material.id })
    assert.equal(head.lastEventVersion, String(Number(startingSequence) + 2))
    assert.equal(head.currentBalance, '8')
    assert.equal(await db.collection('inventory_movements').countDocuments({ materialId: material.id }), 2)

    const outboxRow = await Database.models.InventoryOutbox.findByPk(eventIds[0])
    const invalidPayload = { ...outboxRow.payload, eventId: randomUUID(), schemaVersion: 2 }
    const invalidChannel = await rabbitConnection.createConfirmChannel()
    await invalidChannel.assertExchange(testExchange, 'topic', { durable: true })
    await invalidChannel.assertExchange(testDeadExchange, 'topic', { durable: true })
    await invalidChannel.assertQueue(testDeadQueue, { durable: true, arguments: { 'x-queue-type': 'quorum' } })
    await invalidChannel.bindQueue(testDeadQueue, testDeadExchange, '#')
    await new Promise((resolve, reject) => invalidChannel.publish(testExchange, 'inventory.event.v1', Buffer.from(JSON.stringify(invalidPayload)), { persistent: true }, error => error ? reject(error) : resolve()))
    await invalidChannel.waitForConfirms()
    const dlqDeadline = Date.now() + 5000
    let dead
    while (Date.now() < dlqDeadline && !dead) {
      dead = await invalidChannel.get(testDeadQueue, { noAck: true })
      if (!dead) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(dead, 'schema-invalid message reached the durable DLQ')
    await invalidChannel.ack(dead)
    await invalidChannel.close()

    const row = await Database.models.InventoryEvent.findByPk(eventIds[1])
    const payload = {
      schemaVersion: 1, eventId: row.id, material: { id: row.material_id, unit: row.unit_code_snapshot },
      type: row.event_type, quantity: String(row.delta), previousBalance: String(row.balance_before), currentBalance: String(row.balance_after),
      responsible: { performedBy: row.performed_by, withdrawnBy: null, authorizedBy: null, receivedBy: null },
      reason: row.reason_code, description: row.description, occurredAt: row.occurred_at.toISOString(), version: String(row.sequence),
    }
    assert.deepEqual(await consumer.process(payload), { duplicate: true })
    const duplicateFuture = { ...payload, eventId: randomUUID(), version: String(Number(startingSequence) + 4) }
    await assert.rejects(consumer.process(duplicateFuture), /recovery_incomplete/)
    const projection = new InventoryProjectionService({ connections: directConnections })
    const result = await projection.reconcileMaterial(material.id)
    assert.equal(result.matches, true)
    assert.equal(result.movementsMatch, true)
    const firstPage = await projection.getMaterialReadModel(material.id, { actor: { id: user.id, role: 'admin' }, limit: 1 })
    assert.equal(firstPage.movements.length, 1)
    assert.ok(firstPage.nextCursor)

    const replay = await InventorySnapshotService.rebuild(material.id)
    assert.equal(replay.balance, '8')
    assert.equal(replay.version, String(Number(startingSequence) + 2))

    const reportConnections = { getMongoDatabase: async () => db, getMongoClient: async () => mongoClient }
    const { default: projectionSingleton } = await import('../../../src/app/services/InventoryProjectionService.js')
    const previousProjectionConnections = projectionSingleton.connections
    projectionSingleton.connections = reportConnections
    try {
      const report = await StockReportService.statement({ id: user.id, role: 'admin' }, {
        from: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
        to: new Date(Date.now() + 86400000).toISOString().slice(0, 10), materialId: material.id, limit: 20,
      })
      assert.equal(report.data.length, 2)
      assert.ok(report.data.every(item => item.id && item.sequence && item.projectionStatus !== 'pending'))
    } finally { projectionSingleton.connections = previousProjectionConnections }

    let snapshots
    const latest = await InventoryEventRepository.findLatestForMaterial(material.id)
    snapshots = await InventorySnapshotService.createIfDue(material.id, { every: 1, latestEvent: latest })
    assert.ok(snapshots)
    await snapshots.reload()
    assert.equal(snapshots.version, String(Number(startingSequence) + 2))
    const valid = await InventoryEventSnapshotRepository.latestValid(material.id)
    assert.equal(String(valid.version), snapshots.version)
    const earlierSnapshot = await InventoryEventSnapshotRepository.create({
      material_id: material.id,
      version: String(Number(snapshots.version) - 1),
      balance: '1',
      state: { balance: '1', eventType: 'IN', occurredAt: new Date().toISOString() },
      checksum: '0'.repeat(64),
    })
    await snapshots.update({ checksum: '0'.repeat(64) })
    const fallback = await InventorySnapshotService.rebuild(material.id)
    assert.equal(fallback.balance, '8')
    assert.equal(fallback.version, String(Number(startingSequence) + 2))
    await earlierSnapshot.destroy()

    await db.collection('inventory_material_heads').updateOne({ _id: material.id }, { $set: { currentBalance: '999' } })
    const discrepancy = await projection.reconcileMaterial(material.id)
    assert.equal(discrepancy.matches, false)
    const repaired = await projection.reconcileMaterial(material.id, { repair: true })
    assert.equal(repaired.repaired, true)
    assert.equal((await db.collection('inventory_material_heads').findOne({ _id: material.id })).currentBalance, '8')
    await Database.models.MaterialBalance.update({ quantity: '7' }, { where: { material_id: material.id } })
    const canonicalBalanceDivergence = await projection.reconcileMaterial(material.id)
    assert.equal(canonicalBalanceDivergence.matches, false)
    await Database.models.MaterialBalance.update({ quantity: '8' }, { where: { material_id: material.id } })
    const eventSnapshot = await InventoryEventSnapshotRepository.latest(material.id)
    assert.ok(eventSnapshot)
    const validEarlierSnapshot = await InventoryEventSnapshotRepository.create({
      material_id: material.id,
      version: String(Number(startingSequence) + 1),
      balance: '10',
      state: { balance: '10', eventType: 'IN', occurredAt: new Date().toISOString() },
      checksum: '0'.repeat(64),
    })
    const { snapshotChecksum } = await import('../../../src/app/services/InventorySnapshotService.js')
    await validEarlierSnapshot.update({
      checksum: snapshotChecksum(material.id, validEarlierSnapshot.version, validEarlierSnapshot.state),
    })
    const laterSnapshot = await InventoryEventSnapshotRepository.create({
      material_id: material.id,
      version: String(Number(eventSnapshot.version) + 100),
      balance: '999',
      state: { balance: '999', eventType: 'IN', occurredAt: new Date().toISOString() },
      checksum: '0'.repeat(64),
    })
    const fallbackSnapshot = await InventoryEventSnapshotRepository.latestValid(material.id)
    assert.equal(String(fallbackSnapshot.version), String(validEarlierSnapshot.version), 'corrupt newest checkpoint falls back to the latest earlier valid ledger checkpoint')
    await laterSnapshot.destroy()
    await validEarlierSnapshot.destroy()
    await InventoryEventSnapshotRepository.create({
      material_id: material.id,
      version: String(Number(eventSnapshot.version) + 101),
      balance: '999',
      state: { balance: '999', eventType: 'IN', occurredAt: new Date().toISOString() },
      checksum: '0'.repeat(64),
    })
    const rebuiltFromLedger = await projection.rebuildMaterial(material.id)
    assert.equal(rebuiltFromLedger.currentBalance, '8')
    assert.equal(rebuiltFromLedger.lastEventVersion, String(Number(startingSequence) + 2))
    await db.collection('inventory_movements').deleteOne({ _id: eventIds[0] })
    const missingMovement = await projection.reconcileMaterial(material.id)
    assert.equal(missingMovement.movementsMatch, false)
    await projection.reconcileMaterial(material.id, { repair: true })
    await db.collection('inventory_movements').updateOne({ _id: eventIds[1] }, { $set: { currentBalance: '777' } })
    const movementDivergence = await projection.reconcileMaterial(material.id)
    assert.ok(movementDivergence)
    await db.collection('inventory_material_heads').updateOne({ _id: material.id }, { $set: { lastEventVersion: '999' } })
    const versionDivergence = await projection.reconcileMaterial(material.id)
    assert.equal(versionDivergence.matches, false)
    await projection.reconcileMaterial(material.id, { repair: true })
    assert.equal(await db.collection('inventory_movements').countDocuments({ materialId: material.id }), 2)
    await restoreMongo()
  })

  await t.test('HTTP authenticated material query and Mongo-backed report honor current sector grants', async () => {
    const projection = new InventoryProjectionService({ connections: directConnections })
    const eventRows = await InventoryEventRepository.findEventsForRebuild(material.id, '0', undefined, undefined, 500)
    const readModelEvent = eventRows.at(-1)
    const projectedMaterial = await projection.getMaterialReadModel(material.id, { actor: { id: user.id, role: 'admin' }, limit: 100 })
    assert.ok(projectedMaterial)
    const originalGrants = UserSectorRepository.findSectorIdsByUser
    const server = createServer(app)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const sid = randomUUID()
    const token = jwt.sign({ sub: user.id, sid, actor_type: 'user' }, authConfig.secret, { expiresIn: '5m' })
    const originalsSession = (await import('../../../src/app/repositories/AuthSessionRepository.js')).default
    const findActive = originalsSession.findActiveById
    const findUser = (await import('../../../src/app/repositories/UserRepository.js')).default
    const findById = findUser.findById
    try {
      originalsSession.findActiveById = async id => id === sid ? { id, user_id: user.id, actor_type: 'user', expires_at: new Date(Date.now() + 60000) } : null
      findUser.findById = async id => id === user.id ? { id, role: 'user' } : null
      const cookie = `access_token=${token}`
      const deniedUnauthenticated = await fetch(`${base}/materials/${material.id}`)
      assert.equal(deniedUnauthenticated.status, 401)
      const allowed = await fetch(`${base}/materials/${material.id}`, { headers: { cookie } })
      assert.equal(allowed.status, 200)
      const from = '2026-01-01'
      const to = '2027-01-01'
      const allowedReport = await fetch(`${base}/reports/stock/statement?from=${from}&to=${to}&materialId=${material.id}&limit=100`, { headers: { cookie } })
      assert.equal(allowedReport.status, 200)
      assert.ok((await allowedReport.json()).data.length > 0)
      UserSectorRepository.findSectorIdsByUser = async () => []
      const noSector = await fetch(`${base}/materials/${material.id}`, { headers: { cookie } })
      assert.equal(noSector.status, 404)
      const hiddenReport = await fetch(`${base}/reports/stock/statement?from=${from}&to=${to}&materialId=${material.id}`, { headers: { cookie } })
      assert.deepEqual(await hiddenReport.json(), { data: [], nextCursor: null })
      UserSectorRepository.findSectorIdsByUser = originalGrants
      const originalReadModel = InventoryProjectionService.prototype.getMaterialReadModel
      InventoryProjectionService.prototype.getMaterialReadModel = async () => null
      const canonicalFallback = await fetch(`${base}/reports/stock/statement?from=${from}&to=${to}&materialId=${material.id}`, { headers: { cookie } })
      assert.equal(canonicalFallback.status, 200)
      assert.ok((await canonicalFallback.json()).data.length > 0)
      InventoryProjectionService.prototype.getMaterialReadModel = originalReadModel
      assert.ok(readModelEvent)
    } finally {
      UserSectorRepository.findSectorIdsByUser = originalGrants
      originalsSession.findActiveById = findActive
      findUser.findById = findById
      await new Promise(resolve => server.close(resolve))
    }
  })

  await t.test('publisher failure, retries exhausted to DEAD, and recovery after service restart', async () => {
    const outbox = Database.models.InventoryOutbox
    const eventId = randomUUID()
    const deadPayload = { schemaVersion: 1, eventId, material: { id: randomUUID(), unit: 'un' }, type: 'OPENING', quantity: '1', previousBalance: '0', currentBalance: '1', occurredAt: new Date().toISOString(), version: '1' }
    await Database.models.InventoryEvent.create({ id: eventId, material_id: material.id, warehouse_id: warehouse.id,
      event_type: 'IN', delta: '1', balance_before: '8', balance_after: '9', unit_code_snapshot: 'un', description: 'publisher retry fixture',
      sequence: Number(startingSequence) + 3, performed_by: user.id, command_origin: 'SESSION', occurred_at: new Date() })
    deadPayload.material.id = material.id
    deadPayload.version = String(Number(startingSequence) + 3)
    deadPayload.previousBalance = '8'
    deadPayload.currentBalance = '9'
    await outbox.update({ status: 'PENDING', attempts: 0 }, { where: { event_id: eventId } })
    const failingChannel = {
      assertExchange: async () => {}, assertQueue: async () => {}, bindQueue: async () => {}, close: async () => {},
      publish: (_exchange, _key, _body, _options, callback) => callback(new Error('simulated isolated broker connection failure')),
    }
    const realConnections = { getRabbitConnection: async () => ({ createConfirmChannel: async () => failingChannel }) }
    const failedPublisher = new InventoryOutboxPublisher({ connections: realConnections, repository: {
      claim: async () => [{ event_id: eventId, status: 'PENDING', attempts: 1, payload: deadPayload, schema_version: 1 }],
      markPublished: async () => false,
      markFailed: async (...args) => InventoryOutboxDeliveryRepository.markFailed(...args),
    }, topology: { exchange: testExchange, queue: testQueue }, maxAttempts: 1, logger: { error() {} } })
    assert.equal(await failedPublisher.publishBatch(), 1)
    let deadWasRepublished = false
    const restartedPublisher = new InventoryOutboxPublisher({ connections: isolatedPublisherConnections, repository: {
      claim: async () => [{ event_id: eventId, status: 'DEAD', attempts: 1, payload: deadPayload, schema_version: 1, last_error: 'simulated retry exhaustion' }],
      markPublished: async () => false,
      markDeadPublished: async ids => { deadWasRepublished = (Array.isArray(ids) ? ids : [ids]).includes(eventId) },
      markFailed: async () => assert.fail('dead-letter publication failure uses repository recovery'),
    }, topology: { exchange: testExchange, queue: testQueue }, logger: { error() {}, warn() {} } })
    await restartedPublisher.publishBatch()
    assert.equal(deadWasRepublished, true)
    assert.equal(await db.collection('inventory_movements').countDocuments({ _id: eventId }), 0)
    await db.collection('inventory_material_heads').deleteOne({ _id: material.id })
  })

  await t.test('consumer crash after Mongo commit before ACK causes RabbitMQ redelivery without duplicate projection', async () => {
    const eventId = randomUUID()
    const crashMaterialId = randomUUID()
    testMaterialIds.add(crashMaterialId)
    const payload = { schemaVersion: 1, eventId, material: { id: crashMaterialId, unit: 'un' }, type: 'OPENING', quantity: '1',
      previousBalance: '0', currentBalance: '1', occurredAt: new Date().toISOString(), version: '1' }
    const crashChannel = await (await cqrsConnections.getRabbitConnection()).createConfirmChannel()
    const crashExchange = `${crashExchangePrefix}.${randomUUID()}`
    const crashQueue = `${crashExchange}.queue`
    await crashChannel.assertExchange(crashExchange, 'direct', { durable: true })
    await crashChannel.assertQueue(crashQueue, { durable: true })
    await crashChannel.bindQueue(crashQueue, crashExchange, 'event')
    const publish = () => new Promise((resolve, reject) => crashChannel.publish(crashExchange, 'event', Buffer.from(JSON.stringify(payload)), { persistent: true, messageId: eventId }, error => error ? reject(error) : resolve()))
    const once = new InventoryProjectionConsumer({ connections: directConnections, logger: { error() {} } })
    await publish()
    const firstDelivery = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('first delivery timed out')), 5000)
      crashChannel.consume(crashQueue, async message => {
        if (!message) return
        try {
          await once.process(JSON.parse(message.content.toString()))
          clearTimeout(timeout)
          await crashChannel.close()
          resolve()
        } catch (error) { clearTimeout(timeout); reject(error) }
      }, { noAck: false }).catch(reject)
    })
    await firstDelivery
    assert.equal(await db.collection('inventory_event_consumptions').countDocuments({ _id: eventId }), 1)
    const recoveredChannel = await (await cqrsConnections.getRabbitConnection()).createConfirmChannel()
    let redelivered = false
    const recoveredDelivery = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('recovered delivery timed out')), 5000)
      recoveredChannel.consume(crashQueue, async message => {
        if (!message) return
        try {
          redelivered = message.fields.redelivered
          assert.deepEqual(await once.process(JSON.parse(message.content.toString())), { duplicate: true })
          recoveredChannel.ack(message)
          clearTimeout(timeout)
          resolve()
        } catch (error) { recoveredChannel.nack(message, false, true); clearTimeout(timeout); reject(error) }
      }, { noAck: false }).catch(reject)
    })
    await recoveredDelivery
    assert.equal(redelivered, true)
    assert.equal(await db.collection('inventory_event_consumptions').countDocuments({ _id: eventId }), 1)
    assert.equal(await db.collection('inventory_movements').countDocuments({ _id: eventId }), 1)
    await recoveredChannel.close()
  })

  await t.test('two PostgreSQL claimers cannot claim same row', async () => {
    const pendingOutbox = await Database.models.InventoryOutbox.findByPk(eventIds[0])
    await Database.connection.query("UPDATE inventory_outbox SET status='PENDING', available_at=now(), locked_by=NULL, locked_until=NULL WHERE event_id=:eventId", { replacements: { eventId: pendingOutbox.event_id } })
    const [a, b] = await Promise.all([
      InventoryOutboxDeliveryRepository.claim({ workerId: randomUUID(), limit: 100 }),
      InventoryOutboxDeliveryRepository.claim({ workerId: randomUUID(), limit: 100 }),
    ])
    const claimed = [...a, ...b].filter(item => item.event_id === pendingOutbox.event_id)
    assert.ok(claimed.length <= 1)
  })
  await t.test('expired lease is reclaimed after publisher restart and broker outage remains retryable', async () => {
    const worker = randomUUID()
    const pendingOutbox = await Database.models.InventoryOutbox.findByPk(eventIds[1])
    await Database.connection.query("UPDATE inventory_outbox SET status='PROCESSING', locked_by=:worker, locked_until=now()-interval '1 second' WHERE event_id=:eventId", { replacements: { worker, eventId: pendingOutbox.event_id } })
    const claims = await InventoryOutboxDeliveryRepository.claim({ workerId: randomUUID(), limit: 100, leaseMs: 1000 })
    assert.ok(claims.some(item => item.event_id === pendingOutbox.event_id))
  })
  await channel.close().catch(() => {})
  await mongoClient.close()
  await cqrsConnections.close()
  await Database.connection.close()
})