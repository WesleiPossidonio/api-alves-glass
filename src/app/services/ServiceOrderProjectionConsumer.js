import { createCqrsConnections } from '../../config/cqrs.js';
import ServiceOrderProjectionService, {
  SERVICE_ORDER_PROJECTION_COLLECTIONS,
} from './ServiceOrderProjectionService.js';

export const SERVICE_ORDER_QUEUE = 'service-orders.projection.v1';
export const SERVICE_ORDER_PARKING_QUEUE =
  'service-orders.projection.parking.v1';
const MAX_GAP_RETRIES = 8;
const RETRY_DELAYS = [1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000];

export class ServiceOrderProjectionConsumer {
  constructor({ connections = createCqrsConnections(), projection } = {}) {
    this.connections = connections;
    this.projection =
      projection ?? new ServiceOrderProjectionService({ connections });
  }

  async start() {
    const connection = await this.connections.getRabbitConnection();
    const channel = await connection.createConfirmChannel();
    await channel.assertExchange('service-orders.events.v1', 'topic', {
      durable: true,
    });
    await channel.assertExchange('service-orders.parking.v1', 'direct', {
      durable: true,
    });
    await channel.assertExchange('service-orders.retry.v1', 'direct', {
      durable: true,
    });
    await channel.assertQueue(SERVICE_ORDER_QUEUE, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    await channel.assertQueue(SERVICE_ORDER_PARKING_QUEUE, { durable: true });
    for (const delay of RETRY_DELAYS) {
      const retryQueue = this.retryQueueName(delay);
      await channel.assertQueue(retryQueue, {
        durable: true,
        arguments: {
          'x-queue-type': 'quorum',
          'x-message-ttl': delay,
          'x-dead-letter-exchange': 'service-orders.retry.v1',
          'x-dead-letter-routing-key': SERVICE_ORDER_QUEUE,
        },
      });
    }
    await channel.bindQueue(
      SERVICE_ORDER_QUEUE,
      'service-orders.events.v1',
      '#',
    );
    await channel.bindQueue(
      SERVICE_ORDER_QUEUE,
      'service-orders.retry.v1',
      SERVICE_ORDER_QUEUE,
    );
    await channel.bindQueue(
      SERVICE_ORDER_PARKING_QUEUE,
      'service-orders.parking.v1',
      SERVICE_ORDER_PARKING_QUEUE,
    );
    channel.prefetch(20);
    await this.projection.ensureIndexes(
      await this.connections.getMongoDatabase(),
    );
    await channel.consume(
      SERVICE_ORDER_QUEUE,
      (message) => this.handle(channel, message),
      { noAck: false },
    );
    return channel;
  }

  async handle(channel, message) {
    if (!message) return;
    let envelope;
    try {
      envelope = JSON.parse(message.content.toString('utf8'));
    } catch (error) {
      return this.park(channel, message, 'INVALID_JSON', error.message);
    }
    let result;
    try {
      result = await this.projection.apply(envelope);
    } catch (error) {
      const retries =
        Number(
          message.properties.headers?.['x-service-order-processing-retries'] ??
            0,
        ) + 1;
      if (retries > MAX_GAP_RETRIES)
        return this.park(channel, message, 'PROJECTION_FAILURE', error.message);
      const delay =
        RETRY_DELAYS[Math.min(retries - 1, RETRY_DELAYS.length - 1)];
      await this.publishConfirmed(
        channel,
        '',
        message.content,
        {
          ...message.properties,
          headers: {
            ...(message.properties.headers ?? {}),
            'x-service-order-processing-retries': retries,
          },
        },
        this.retryQueueName(delay),
      );
      channel.ack(message);
      return { status: 'RETRY', error: error.message };
    }
    if (result.status === 'APPLIED' || result.status === 'DUPLICATE') {
      channel.ack(message);
      return result;
    }
    if (result.status === 'CONFLICT')
      return this.park(
        channel,
        message,
        'VERSION_CONTENT_CONFLICT',
        'Previously applied version has conflicting content',
      );
    if (result.status === 'GAP') {
      const retries =
        Number(
          message.properties.headers?.['x-service-order-gap-retries'] ?? 0,
        ) + 1;
      if (retries > MAX_GAP_RETRIES)
        return this.park(
          channel,
          message,
          'VERSION_GAP',
          `expected ${result.expectedVersion}`,
        );
      const delay =
        RETRY_DELAYS[Math.min(retries - 1, RETRY_DELAYS.length - 1)];
      const retryQueue = this.retryQueueName(delay);
      await this.publishConfirmed(
        channel,
        '',
        message.content,
        {
          ...message.properties,
          headers: {
            ...(message.properties.headers ?? {}),
            'x-service-order-gap-retries': retries,
          },
        },
        retryQueue,
      );
      channel.ack(message);
      return result;
    }
    return this.park(
      channel,
      message,
      result.error ?? 'INVALID_ENVELOPE',
      'Envelope rejected by projection',
    );
  }

  async park(channel, message, code, description) {
    const headers = {
      ...(message.properties.headers ?? {}),
      'x-service-order-error': code,
    };
    await this.publishConfirmed(
      channel,
      'service-orders.parking.v1',
      message.content,
      {
        persistent: true,
        contentType: 'application/json',
        headers: {
          ...headers,
          'x-service-order-error-description': description,
        },
        messageId: message.properties.messageId,
      },
      SERVICE_ORDER_PARKING_QUEUE,
    );
    channel.ack(message);
    return { status: 'PARKED', code, description };
  }

  retryQueueName(delay) {
    return `service-orders.projection.retry.${delay}`;
  }

  publishConfirmed(channel, exchange, content, options, routingKey = '') {
    return new Promise((resolve, reject) => {
      channel.publish(exchange, routingKey, content, options, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const consumer = new ServiceOrderProjectionConsumer();
  consumer.start().catch((error) => {
    console.error('ServiceOrder projection consumer stopped', error);
    process.exitCode = 1;
  });
}

export { SERVICE_ORDER_PROJECTION_COLLECTIONS };
