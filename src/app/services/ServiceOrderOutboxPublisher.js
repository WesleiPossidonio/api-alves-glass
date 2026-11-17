import ServiceOrderOutbox from '../models/ServiceOrderOutbox.js';
import Database from '../../database/index.js';
import { randomUUID } from 'node:crypto';
import { createCqrsConnections } from '../../config/cqrs.js';
import { Op } from 'sequelize';

import {
  SERVICE_ORDER_EXCHANGE,
  ensureServiceOrderTopology,
  publishServiceOrderConfirmed,
} from './serviceOrderMessagingTopology.js';

export { SERVICE_ORDER_EXCHANGE };

export class ServiceOrderOutboxPublisher {
  constructor({
    database = Database,
    connections,
    publisherId = randomUUID(),
    maxAttempts = 12,
  } = {}) {
    this.database = database;
    this.connections = connections ?? createCqrsConnections();
    this.publisherId = publisherId;
    this.maxAttempts = maxAttempts;
  }

  async claim(limit = 50, leaseMs = 30000) {
    return this.database.connection.transaction(async (transaction) => {
      await ServiceOrderOutbox.update(
        { status: 'PARKED', locked_by: null, locked_until: null },
        {
          where: {
            status: 'PROCESSING',
            locked_until: { [Op.lt]: new Date() },
            attempts: { [Op.gte]: this.maxAttempts },
          },
          transaction,
        },
      );
      const rows = await ServiceOrderOutbox.findAll({
        where: {
          [Op.or]: [
            { status: 'PENDING', available_at: { [Op.lte]: new Date() } },
            {
              status: 'PROCESSING',
              locked_until: { [Op.lt]: new Date() },
              attempts: { [Op.lt]: this.maxAttempts },
            },
          ],
        },
        order: [
          ['available_at', 'ASC'],
          ['created_at', 'ASC'],
        ],
        limit,
        transaction,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
      });
      const claimed = [];
      for (const row of rows) {
        const attempts = Number(row.attempts) + 1;
        await row.update(
          {
            status: 'PROCESSING',
            locked_by: this.publisherId,
            locked_until: new Date(Date.now() + leaseMs),
            attempts,
          },
          { transaction },
        );
        claimed.push({ ...row.get(), attempts });
      }
      return claimed;
    });
  }

  async publishBatch({ limit = 50 } = {}) {
    const rows = await this.claim(limit);
    if (!rows.length) return { claimed: 0, published: 0 };
    let channel;
    try {
      channel = await this.openConfirmChannel();
    } catch (error) {
      await Promise.all(rows.map((row) => this.markFailed(row, error)));
      return { claimed: rows.length, published: 0 };
    }
    let published = 0;
    try {
      for (const row of rows) {
        try {
          await publishServiceOrderConfirmed(
            channel,
            SERVICE_ORDER_EXCHANGE,
            row.event_type,
            Buffer.from(JSON.stringify(row.payload)),
            {
              persistent: true,
              contentType: 'application/json',
              messageId: row.event_id,
            },
          );
          await this.markPublished(row.event_id);
          row.published = true;
          published += 1;
        } catch (error) {
          await this.markFailed(row, error);
        }
      }
    } catch (error) {
      await Promise.all(
        rows
          .filter((row) => !row.published)
          .map((row) => this.markFailed(row, error)),
      );
    } finally {
      await channel.close();
    }
    return { claimed: rows.length, published };
  }

  async openConfirmChannel() {
    const connection = await this.connections.getRabbitConnection();
    const channel = await connection.createConfirmChannel();
    try {
      await ensureServiceOrderTopology(channel);
    } catch (error) {
      await channel.close().catch(() => {});
      throw error;
    }
    return channel;
  }

  async markPublished(eventId) {
    await ServiceOrderOutbox.update(
      {
        status: 'PUBLISHED',
        locked_by: null,
        locked_until: null,
        last_error: null,
      },
      { where: { event_id: eventId, locked_by: this.publisherId } },
    );
  }

  async markFailed(row, error) {
    const attempts = Number(row.attempts);
    const parked = attempts >= this.maxAttempts;
    const delay = Math.min(1000 * 2 ** Math.min(attempts, 10), 15 * 60 * 1000);
    await ServiceOrderOutbox.update(
      {
        status: parked ? 'PARKED' : 'PENDING',
        available_at: new Date(Date.now() + delay),
        locked_by: null,
        locked_until: null,
        last_error: String(error?.message ?? error).slice(0, 4000),
      },
      { where: { event_id: row.event_id, locked_by: this.publisherId } },
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const publisher = new ServiceOrderOutboxPublisher();
  const poll = async () => {
    try {
      await publisher.publishBatch();
    } finally {
      setTimeout(poll, 1000).unref();
    }
  };
  poll().catch((error) => {
    console.error('ServiceOrder outbox publisher stopped', error);
    process.exitCode = 1;
  });
}
