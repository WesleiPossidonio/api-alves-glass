import { INVENTORY_EXCHANGE, INVENTORY_QUEUE, INVENTORY_ROUTING_KEY } from './InventoryOutboxPublisher.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

export function validateInventoryEnvelope(event) {
  if (!event || event.schemaVersion !== 1 || !UUID.test(event.eventId ?? '') || !UUID.test(event.material?.id ?? '') ||
    !['OPENING', 'IN', 'OUT', 'RETURN', 'ADJUSTMENT'].includes(event.type) ||
    !decimal.test(String(event.quantity)) || !decimal.test(String(event.previousBalance)) ||
    !decimal.test(String(event.currentBalance)) || !/^\d+$/.test(String(event.version)) ||
    !Number.isFinite(Date.parse(event.occurredAt))) throw new Error('invalid_inventory_event_envelope')
  return event
}

export class InventoryProjectionConsumer {
  constructor({ connections, logger = console, maxRetryDelayMs = 30000, loadCanonicalEvents, topology = {} } = {}) {
    this.connections = connections
    this.logger = logger
    this.maxRetryDelayMs = maxRetryDelayMs
    this.loadCanonicalEvents = loadCanonicalEvents
    this.exchange = topology.exchange ?? INVENTORY_EXCHANGE
    this.queue = topology.queue ?? INVENTORY_QUEUE
    this.routingKey = topology.routingKey ?? INVENTORY_ROUTING_KEY
    this.deadExchange = `${this.exchange}.dead`
    this.retryQueue = `${this.queue}.retry.5s`
    this.maxRetryCount = topology.maxRetryCount ?? 8
    this.stopping = false
    this.consumerTag = null
  }

  async apply(event, { session, recovery = false } = {}) {
    validateInventoryEnvelope(event)
    const db = await this.connections.getMongoDatabase()
    const dedupe = db.collection('inventory_event_consumptions')
    const heads = db.collection('inventory_material_heads')
    const movements = db.collection('inventory_movements')
    const head = await heads.findOne({ _id: event.material.id }, { session })
    const version = BigInt(event.version)
    if (head && version <= BigInt(head.lastEventVersion)) {
      const exists = await dedupe.findOne({ _id: event.eventId }, { session })
      if (exists) {
        if (exists.materialId === event.material.id && String(exists.version) === String(event.version)) return { duplicate: true }
        throw Object.assign(new Error('inventory_event_id_conflict'), { permanent: true })
      }
      if (version < BigInt(head.lastEventVersion)) {
        const projected = await movements.findOne({ materialId: event.material.id, version: String(event.version) }, { session })
        if (projected?.eventId === event.eventId && String(projected.currentBalance) === String(event.currentBalance)) return { duplicate: true }
        throw Object.assign(new Error('inventory_event_historical_conflict'), { permanent: true })
      }
      throw Object.assign(new Error('inventory_event_version_conflict'), { permanent: true })
    }
    const expected = BigInt(head?.lastEventVersion ?? 0) + 1n
    if (version !== expected) throw Object.assign(new Error('inventory_event_out_of_order'), { retryable: true, expected: expected.toString() })
    if (recovery && !head && version !== 1n) throw Object.assign(new Error('inventory_projection_recovery_missing_origin'), { permanent: true })
    if (String(event.previousBalance) !== String(head?.currentBalance ?? '0')) {
      throw Object.assign(new Error('inventory_event_balance_chain_mismatch'), { permanent: true })
    }

    const existing = await dedupe.findOne({ _id: event.eventId }, { session })
    if (existing) {
      if (existing.materialId === event.material.id && String(existing.version) === String(event.version)) return { duplicate: true }
      throw Object.assign(new Error('inventory_event_id_conflict'), { permanent: true })
    }
    const replacement = {
      _id: event.material.id,
      materialId: event.material.id,
      currentBalance: String(event.currentBalance),
      lastEventVersion: String(event.version),
      updatedAt: new Date(),
    }
    if (!head) await heads.insertOne(replacement, { session })
    else {
      const updated = await heads.replaceOne({ _id: event.material.id, lastEventVersion: String(head.lastEventVersion) }, replacement, { session })
      if (updated.modifiedCount !== 1) throw Object.assign(new Error('inventory_event_head_concurrency'), { retryable: true })
    }
    await movements.insertOne({
      _id: event.eventId,
      materialId: event.material.id,
      eventId: event.eventId,
      type: event.type,
      material: event.material,
      quantity: String(event.quantity),
      previousBalance: String(event.previousBalance),
      currentBalance: String(event.currentBalance),
      withdrawnBy: event.responsible?.withdrawnBy ? { id: event.responsible.withdrawnBy } : null,
      authorizedBy: event.responsible?.authorizedBy ? { id: event.responsible.authorizedBy } : null,
      performedBy: event.responsible?.performedBy ? { id: event.responsible.performedBy } : null,
      receivedBy: event.responsible?.receivedBy ? { id: event.responsible.receivedBy } : null,
      reason: event.reason ?? null,
      description: event.description,
      occurredAt: new Date(event.occurredAt),
      version: String(event.version),
    }, { session })
    await dedupe.insertOne({ _id: event.eventId, materialId: event.material.id, version: event.version, consumedAt: new Date() }, { session })
    return { duplicate: false }
  }

  async process(event) {
    validateInventoryEnvelope(event)
    if (!this.materialLocks) this.materialLocks = new Map()
    const prior = this.materialLocks.get(event.material.id) ?? Promise.resolve()
    const operation = prior.catch(() => {}).then(() => this.#processOrdered(event))
    this.materialLocks.set(event.material.id, operation)
    try { return await operation } finally {
      if (this.materialLocks.get(event.material.id) === operation) this.materialLocks.delete(event.material.id)
    }
  }

  async #processOrdered(event) {
    const db = await this.connections.getMongoDatabase()
    const head = await db.collection('inventory_material_heads').findOne({ _id: event.material.id })
    const incomingVersion = BigInt(event.version)
    const expectedVersion = BigInt(head?.lastEventVersion ?? '0') + 1n
    if (incomingVersion > expectedVersion && !this.loadCanonicalEvents) {
      throw Object.assign(new Error('inventory_event_out_of_order'), { retryable: true, expected: expectedVersion.toString() })
    }
    if (incomingVersion > expectedVersion) {
      const missing = await this.loadCanonicalEvents(event.material.id, String(expectedVersion), String(incomingVersion - 1n))
      if (!Array.isArray(missing) || BigInt(missing.length) !== incomingVersion - expectedVersion) {
        throw Object.assign(new Error('inventory_projection_recovery_incomplete'), { retryable: true, expected: expectedVersion.toString() })
      }
      for (let offset = 0; offset < missing.length; offset += 1) {
        const canonical = missing[offset]
        if (canonical.material?.id !== event.material.id || BigInt(canonical.version) !== expectedVersion + BigInt(offset)) {
          throw Object.assign(new Error('inventory_projection_recovery_invalid_sequence'), { permanent: true })
        }
        await this.#applyTransaction(canonical, { recovery: true })
      }
    }
    return this.#applyTransaction(event)
  }

  async #applyTransaction(event, { recovery = false } = {}) {
    const client = await this.connections.getMongoClient()
    const session = client.startSession()
    try {
      let result
      await session.withTransaction(async () => { result = await this.apply(event, { session, recovery }) })
      return result
    } finally { await session.endSession() }
  }

  async start() {
    this.stopping = false
    const connection = await this.connections.getRabbitConnection()
    const channel = await connection.createConfirmChannel()
    this.channel = channel
    const deadExchange = `${this.exchange}.dead`
    const deadQueue = `${this.queue}.dead`
    await channel.assertExchange(this.exchange, 'topic', { durable: true })
    await channel.assertQueue(this.queue, { durable: true, arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': deadExchange,
      'x-dead-letter-routing-key': 'invalid',
    } })
    await channel.bindQueue(this.queue, this.exchange, this.routingKey)
    await channel.assertExchange(deadExchange, 'topic', { durable: true })
    await channel.assertQueue(deadQueue, { durable: true, arguments: { 'x-queue-type': 'quorum' } })
    await channel.bindQueue(deadQueue, deadExchange, 'invalid')
    await channel.bindQueue(deadQueue, deadExchange, 'inventory.event.dead.v1')
    const retryQueue = this.retryQueue
    await channel.assertQueue(retryQueue, { durable: true, arguments: {
      'x-queue-type': 'quorum', 'x-message-ttl': 5000,
      'x-dead-letter-exchange': this.exchange,
      'x-dead-letter-routing-key': this.routingKey,
    } })
    await channel.bindQueue(retryQueue, deadExchange, 'retry')
    await channel.prefetch(1)
    const result = await channel.consume(this.queue, async message => {
      if (!message || this.stopping) return
      const retryCount = Number(message.properties.headers?.['x-retry-count'] ?? 0)
      try {
        const event = validateInventoryEnvelope(JSON.parse(message.content.toString('utf8')))
        await this.process(event)
        channel.ack(message)
      } catch (error) {
        this.logger.error?.('Inventory projection consumer failed', { error: error?.message })
        if (error.permanent || error.message === 'invalid_inventory_event_envelope' || error instanceof SyntaxError || retryCount >= this.maxRetryCount) {
          channel.nack(message, false, false)
        } else {
          const retry = Buffer.from(message.content)
          try {
            await new Promise((resolve, reject) => channel.publish(this.deadExchange, 'retry', retry, {
              persistent: true,
              contentType: message.properties.contentType,
              messageId: message.properties.messageId,
              headers: { ...message.properties.headers, 'x-retry-count': retryCount + 1 },
            }, error => error ? reject(error) : resolve()))
            channel.ack(message)
          } catch {
            channel.nack(message, false, true)
          }
        }
      }
    }, { noAck: false })
    this.consumerTag = result.consumerTag
    return this
  }

  async stop() {
    this.stopping = true
    if (this.channel && this.consumerTag) await this.channel.cancel(this.consumerTag).catch(() => {})
    await this.channel?.close().catch(() => {})
    this.channel = null
    await this.connections?.close?.()
  }
}

if (process.argv[1] && process.argv[1].endsWith('InventoryProjectionConsumer.js')) {
  const { cqrsConnections } = await import('../../config/cqrs.js')
  const { default: InventoryEventRepository } = await import('../repositories/InventoryEventRepository.js')
  const { default: InventoryOutboxService } = await import('./InventoryOutboxService.js')
  const consumer = new InventoryProjectionConsumer({ connections: cqrsConnections, loadCanonicalEvents: async (materialId, fromVersion, throughVersion) => {
    const events = await InventoryEventRepository.findEventsForRebuild(materialId, (BigInt(fromVersion) - 1n).toString(), throughVersion)
    return events.map(InventoryOutboxService.createInventoryEventEnvelope).map(envelope => envelope.payload)
  } })
  const stop = async () => { await consumer.stop(); await cqrsConnections.close(); process.exit(0) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  consumer.start().catch(error => { console.error('Inventory projection consumer terminated', error); process.exitCode = 1 })
}