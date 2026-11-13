import { randomUUID } from 'node:crypto'
import InventoryOutboxDeliveryRepository from '../repositories/InventoryOutboxDeliveryRepository.js'
import { cqrsConnections } from '../../config/cqrs.js'

const EXCHANGE = 'alves.inventory.events.v1'
const QUEUE = 'alves.inventory.projection.v1'
const ROUTING_KEY = 'inventory.event.v1'
const DEAD_ROUTING_KEY = 'inventory.event.dead.v1'

export function retryDelay(attempt, baseMs = 1000, ceilingMs = 300000) {
  return Math.min(ceilingMs, baseMs * (2 ** Math.max(0, attempt - 1)))
}

export class InventoryOutboxPublisher {
  constructor({ repository = InventoryOutboxDeliveryRepository, connections = cqrsConnections, workerId = randomUUID(), batchSize = 20, leaseMs = 30000, maxAttempts = 12, logger = console, topology = {} } = {}) {
    this.repository = repository
    this.connections = connections
    this.workerId = workerId
    this.batchSize = batchSize
    this.leaseMs = leaseMs
    this.maxAttempts = maxAttempts
    this.logger = logger
    this.exchange = topology.exchange ?? EXCHANGE
    this.queue = topology.queue ?? QUEUE
    this.routingKey = topology.routingKey ?? ROUTING_KEY
    this.stopping = false
    this.inFlight = Promise.resolve()
  }

  async ensureTopology(channel) {
    const deadExchange = `${this.exchange}.dead`
    await channel.assertExchange(this.exchange, 'topic', { durable: true })
    await channel.assertQueue(this.queue, { durable: true, arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': deadExchange,
      'x-dead-letter-routing-key': 'invalid',
    } })
    await channel.bindQueue(this.queue, this.exchange, this.routingKey)
    await channel.assertExchange(deadExchange, 'topic', { durable: true })
    await channel.assertQueue(`${this.queue}.dead`, { durable: true, arguments: { 'x-queue-type': 'quorum' } })
    await channel.bindQueue(`${this.queue}.dead`, deadExchange, '#')
    await channel.assertQueue(`${this.queue}.retry.5s`, { durable: true, arguments: {
      'x-queue-type': 'quorum',
      'x-message-ttl': 5000,
      'x-dead-letter-exchange': this.exchange,
      'x-dead-letter-routing-key': this.routingKey,
    } })
    await channel.bindQueue(`${this.queue}.retry.5s`, deadExchange, 'retry')
  }

  async publishBatch() {
    const channel = await (await this.connections.getRabbitConnection()).createConfirmChannel()
    try {
      await this.ensureTopology(channel)
      const entries = await this.repository.claim({ workerId: this.workerId, limit: this.batchSize, leaseMs: this.leaseMs })
      for (const entry of entries) {
        try {
          if (entry.status === 'DEAD') {
            await new Promise((resolve, reject) => channel.publish(`${this.exchange}.dead`, DEAD_ROUTING_KEY, Buffer.from(JSON.stringify(entry.payload)), {
              persistent: true, contentType: 'application/json', messageId: entry.event_id,
              headers: { schemaVersion: entry.schema_version, failure: entry.last_error ?? 'outbox_retry_exhausted' },
            }, error => error ? reject(error) : resolve()))
            await this.repository.markDeadPublished?.(entry.event_id, this.workerId)
            continue
          }
          await new Promise((resolve, reject) => {
            channel.publish(this.exchange, this.routingKey, Buffer.from(JSON.stringify(entry.payload)), {
              persistent: true,
              contentType: 'application/json',
              messageId: entry.event_id,
              type: entry.event_type,
              headers: { schemaVersion: entry.schema_version, aggregateId: entry.aggregate_id, aggregateVersion: String(entry.aggregate_version) },
            }, error => error ? reject(error) : resolve())
          })
          const updated = await this.repository.markPublished(entry.event_id, this.workerId)
          if (!updated) this.logger.warn?.('Outbox lease lost after broker confirm; message will be redelivered', { eventId: entry.event_id })
        } catch (error) {
          await this.repository.markFailed(entry.event_id, this.workerId, {
            error: error?.message ?? error,
            delayMs: retryDelay(entry.attempts),
            maxAttempts: this.maxAttempts,
          })
          this.logger.error?.('Inventory Outbox publish failed', { eventId: entry.event_id, error: error?.message })
        }
      }
      if (entries.some(entry => entry.status === 'DEAD')) await this.repository.markDeadPublished?.(
        entries.filter(entry => entry.status === 'DEAD').map(entry => entry.event_id), this.workerId,
      )
      if (entries.some(entry => entry.status === 'DEAD')) await new Promise(resolve => setTimeout(resolve, 1000))
      return entries.length
    } finally {
      await channel.close().catch(() => {})
    }
  }

  async start({ intervalMs = 1000, signal } = {}) {
    this.stopping = false
    while (!this.stopping && !signal?.aborted) {
      try { this.inFlight = this.publishBatch(); await this.inFlight }
      catch (error) { this.logger.error?.('Inventory Outbox worker cycle failed', { error: error?.message }) }
      if (!this.stopping && !signal?.aborted) await new Promise(resolve => {
        const timer = setTimeout(resolve, intervalMs)
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
  }

  async stop() {
    this.stopping = true
    await this.inFlight
    await this.connections.close?.()
  }
}

if (process.argv[1] && process.argv[1].endsWith('InventoryOutboxPublisher.js')) {
  const worker = new InventoryOutboxPublisher()
  const stop = async () => { await worker.stop(); await cqrsConnections.close(); process.exit(0) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  worker.start().catch(error => { console.error('Inventory Outbox worker terminated', error); process.exitCode = 1 })
}

export { EXCHANGE as INVENTORY_EXCHANGE, QUEUE as INVENTORY_QUEUE, ROUTING_KEY as INVENTORY_ROUTING_KEY }