import ServiceOrderGrantEvent from '../models/ServiceOrderGrantEvent.js';
import { randomUUID } from 'node:crypto';

class ServiceOrderGrantEventRepository {
  async appendGrantChange({ transaction, grant, actorId, action, reason }) {
    if (!transaction)
      throw new Error('ServiceOrder grant audit requires a transaction');
    const priorEvents = await ServiceOrderGrantEvent.findAll({
      where: { grant_id: grant.id },
      order: [
        ['occurred_at', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const previousHash = priorEvents.at(-1)?.audit_hash ?? '0'.repeat(64);
    const auditId = randomUUID();
    const occurredAt = new Date();
    const event = await ServiceOrderGrantEvent.create(
      {
        id: auditId,
        grant_id: grant.id,
        actor_user_id: actorId,
        target_user_id: grant.user_id,
        sector_id: grant.sector_id,
        operation: grant.operation,
        action,
        reason: reason.trim(),
        occurred_at: occurredAt,
        audit_hash: '0'.repeat(64),
        audit_previous_hash: previousHash,
      },
      { transaction },
    );
    await event.reload({ transaction });
    if (!/^[0-9a-f]{64}$/.test(String(event.audit_hash)))
      throw new Error('Database grant audit hash is missing or invalid');
    return event;
  }
}

export default new ServiceOrderGrantEventRepository();
