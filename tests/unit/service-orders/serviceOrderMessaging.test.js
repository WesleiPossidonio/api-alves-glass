import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  SERVICE_ORDER_QUEUE,
  SERVICE_ORDER_PARKING_QUEUE,
  ServiceOrderProjectionConsumer,
} from '../../../src/app/services/ServiceOrderProjectionConsumer.js';
import {
  SERVICE_ORDER_EXCHANGE,
  ServiceOrderOutboxPublisher,
} from '../../../src/app/services/ServiceOrderOutboxPublisher.js';
import ServiceOrderOutbox from '../../../src/app/models/ServiceOrderOutbox.js';

const message = (envelope, headers = {}) => ({
  content: Buffer.from(JSON.stringify(envelope)),
  properties: { headers, messageId: envelope.eventId },
});

test('outbox publisher waits for broker confirmation before marking an event published', async () => {
  const calls = [];
  const row = {
    event_id: 'event-1',
    event_type: 'Registered',
    payload: { eventId: 'event-1' },
    attempts: 1,
  };
  const channel = Object.assign(new EventEmitter(), {
    assertExchange: async (...args) => calls.push(['exchange', ...args]),
    assertQueue: async (...args) => calls.push(['queue', ...args]),
    bindQueue: async (...args) => calls.push(['binding', ...args]),
    publish: (_exchange, _key, _body, _options, callback) =>
      setImmediate(() => callback(null)),
    close: async () => calls.push(['close']),
  });
  const publisher = new ServiceOrderOutboxPublisher({
    database: {},
    connections: {
      getRabbitConnection: async () => ({
        createConfirmChannel: async () => channel,
      }),
    },
  });
  publisher.claim = async () => [row];
  publisher.markPublished = async (id) => calls.push(['published', id]);
  publisher.markFailed = async () => assert.fail('unexpected failure');

  assert.deepEqual(await publisher.publishBatch(), {
    claimed: 1,
    published: 1,
  });
  assert.equal(calls[0][1], SERVICE_ORDER_EXCHANGE);
  assert.deepEqual(calls.at(-2), ['published', 'event-1']);
  assert.deepEqual(calls.at(-1), ['close']);
});

test('outbox publisher releases a claimed event to retry when RabbitMQ is unavailable', async () => {
  const failed = [];
  const publisher = new ServiceOrderOutboxPublisher({
    database: {},
    connections: {
      getRabbitConnection: async () => {
        throw new Error('broker unavailable');
      },
    },
    publisherId: 'publisher-1',
  });
  publisher.claim = async () => [{ event_id: 'event-1', attempts: 1 }];
  publisher.markFailed = async (row, error) =>
    failed.push([row.event_id, error.message]);

  assert.deepEqual(await publisher.publishBatch(), {
    claimed: 1,
    published: 0,
  });
  assert.deepEqual(failed, [['event-1', 'broker unavailable']]);
});

test('outbox publisher persists retry backoff and error after a claimed delivery fails', async (t) => {
  const originalUpdate = ServiceOrderOutbox.update;
  const changes = [];
  t.after(() => {
    ServiceOrderOutbox.update = originalUpdate;
  });
  ServiceOrderOutbox.update = async (values, options) => {
    changes.push({ values, options });
  };
  const publisher = new ServiceOrderOutboxPublisher({
    database: {},
    connections: {},
    publisherId: 'publisher-retry',
    maxAttempts: 12,
  });
  publisher.claim = async () => [
    {
      event_id: 'event-retry',
      event_type: 'Registered',
      payload: {},
      attempts: 1,
    },
  ];
  publisher.openConfirmChannel = async () =>
    Object.assign(new EventEmitter(), {
      assertExchange: async () => {},
      publish: (_exchange, _key, _body, _options, callback) =>
        setImmediate(() => callback(new Error('nack'))),
      close: async () => {},
    });

  assert.deepEqual(await publisher.publishBatch(), {
    claimed: 1,
    published: 0,
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].values.status, 'PENDING');
  assert.equal(changes[0].values.locked_by, null);
  assert.equal(changes[0].values.last_error, 'nack');
  assert.ok(changes[0].values.available_at instanceof Date);
});

test('projection consumer acknowledges duplicate events without reapplying them', async () => {
  const acked = [];
  let applications = 0;
  const consumer = new ServiceOrderProjectionConsumer({
    connections: {},
    projection: {
      apply: async () => {
        applications += 1;
        return { status: 'DUPLICATE', readModelVersion: '1' };
      },
    },
  });
  const channel = { ack: (item) => acked.push(item) };
  const delivery = message({ eventId: 'event-1', aggregateId: 'order-1' });

  assert.equal((await consumer.handle(channel, delivery)).status, 'DUPLICATE');
  assert.equal((await consumer.handle(channel, delivery)).status, 'DUPLICATE');
  assert.equal(applications, 2);
  assert.deepEqual(acked, [delivery, delivery]);
});

test('projection consumer parks poison JSON in the durable parking queue', async () => {
  const calls = [];
  const consumer = new ServiceOrderProjectionConsumer({
    connections: {},
    projection: {},
  });
  const channel = {
    publish: (_exchange, key, _body, options, callback) => {
      calls.push({ key, options });
      callback(null);
    },
    ack: (delivery) => calls.push({ ack: delivery }),
  };
  const delivery = {
    content: Buffer.from('{bad-json'),
    properties: { headers: {}, messageId: 'poison-1' },
  };

  assert.equal((await consumer.handle(channel, delivery)).status, 'PARKED');
  assert.equal(calls[0].key, SERVICE_ORDER_PARKING_QUEUE);
  assert.equal(
    calls[0].options.headers['x-service-order-error'],
    'INVALID_JSON',
  );
  assert.deepEqual(calls[1], { ack: delivery });
  assert.equal(SERVICE_ORDER_QUEUE, 'service-orders.projection.v1');
});

test('projection consumer retries a version gap and leaves acknowledgement until retry publish is confirmed', async () => {
  const actions = [];
  const consumer = new ServiceOrderProjectionConsumer({
    connections: {},
    projection: {
      apply: async () => ({ status: 'GAP', expectedVersion: '2' }),
    },
  });
  const delivery = message({ eventId: 'event-3', aggregateId: 'order-1' });
  const channel = {
    publish: (_exchange, routingKey, body, options, callback) => {
      actions.push(['publish', routingKey, body, options]);
      setImmediate(() => callback(null));
    },
    ack: (item) => actions.push(['ack', item]),
  };

  const result = await consumer.handle(channel, delivery);
  assert.equal(result.status, 'GAP');
  assert.equal(actions[0][0], 'publish');
  assert.equal(actions[0][1], consumer.retryQueueName(1000));
  assert.equal(actions[0][3].headers['x-service-order-gap-retries'], 1);
  assert.deepEqual(actions[1], ['ack', delivery]);
});

test('projection consumer does not acknowledge a delivery when parking confirmation fails', async () => {
  const delivery = {
    content: Buffer.from('{invalid'),
    properties: { headers: {}, messageId: 'poison-2' },
  };
  let acknowledged = false;
  const consumer = new ServiceOrderProjectionConsumer({
    connections: {},
    projection: {},
  });
  const channel = {
    publish: (_exchange, _routingKey, _body, _options, callback) =>
      setImmediate(() => callback(new Error('broker confirm failed'))),
    ack: () => {
      acknowledged = true;
    },
  };

  await assert.rejects(
    consumer.handle(channel, delivery),
    /broker confirm failed/,
  );
  assert.equal(acknowledged, false);
});
