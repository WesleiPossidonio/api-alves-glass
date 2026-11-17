export const SERVICE_ORDER_EXCHANGE = 'service-orders.events.v1';
export const SERVICE_ORDER_QUEUE = 'service-orders.projection.v1';

// Both processes must establish the durable destination before any publication.
export async function ensureServiceOrderTopology(channel) {
  await channel.assertExchange(SERVICE_ORDER_EXCHANGE, 'topic', {
    durable: true,
  });
  await channel.assertQueue(SERVICE_ORDER_QUEUE, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(SERVICE_ORDER_QUEUE, SERVICE_ORDER_EXCHANGE, '#');
}

export function publishServiceOrderConfirmed(
  channel,
  exchange,
  routingKey,
  content,
  options,
) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      channel.removeListener('return', onReturn);
      channel.removeListener('error', onError);
      channel.removeListener('close', onClose);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () =>
      onError(new Error('ServiceOrder publish channel closed'));
    const onReturn = (message) => {
      if (message.properties.messageId === options.messageId)
        onError(
          new Error(
            `ServiceOrder message unroutable: ${message.fields.replyText}`,
          ),
        );
    };
    channel.on('return', onReturn);
    channel.on('error', onError);
    channel.on('close', onClose);
    try {
      channel.publish(
        exchange,
        routingKey,
        content,
        { ...options, mandatory: true },
        (error) => {
          cleanup();
          if (error) reject(error);
          else resolve();
        },
      );
    } catch (error) {
      onError(error);
    }
  });
}
