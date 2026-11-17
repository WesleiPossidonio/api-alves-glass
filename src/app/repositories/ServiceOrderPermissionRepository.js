import ServiceOrderOperationGrant from '../models/ServiceOrderOperationGrant.js';
import ServiceOrderPermission from '../models/ServiceOrderPermission.js';
import ServiceOrderGrantEventRepository from './ServiceOrderGrantEventRepository.js';
import ServiceOrderGrantEvent from '../models/ServiceOrderGrantEvent.js';
import { randomUUID } from 'node:crypto';
import User from '../models/User.js';
import Sector from '../models/Sector.js';
import UserSector from '../models/UserSector.js';

export const SERVICE_ORDER_OPERATIONS = Object.freeze([
  'CREATE',
  'TRIAGE',
  'ASSIGN',
  'MANAGE_RESPONSIBILITY',
  'ADVANCE_STATUS',
  'REASSIGN',
  'RECORD_EXECUTION',
  'RECORD_QUALITY',
  'DECIDE_REVISION',
  'CANCEL',
  'CLOSE',
  'REOPEN',
  'SUSPEND',
  'RESUME',
  'READ_INTERNAL',
  'READ_REPORTS',
]);

export const SECTOR_MANAGER_OPERATIONS = Object.freeze([
  'MANAGE_RESPONSIBILITY',
  'ADVANCE_STATUS',
  'CANCEL',
  'READ_INTERNAL',
]);

class ServiceOrderPermissionRepository {
  findGrant(grantId, { transaction, lock = false } = {}) {
    return ServiceOrderOperationGrant.findByPk(grantId, {
      transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
  }

  async grant(
    { userId, sectorId, operation, actorId, reason },
    { transaction } = {},
  ) {
    this.assertTransaction(transaction);
    if (typeof actorId !== 'string' || !actorId.trim())
      throw new Error('Authenticated grant actor is required');
    if (userId === actorId)
      throw new Error('Administrator cannot grant OS privilege to self');
    this.assertOperation(operation);
    this.assertReason(reason, 'Permission grant requires a reason');
    const membership = await UserSector.findOne({
      where: { user_id: userId, sector_id: sectorId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!membership)
      throw new Error('Permission target must be a current sector member');
    const [existingActive] = await ServiceOrderOperationGrant.sequelize.query(
      `SELECT p.grant_id
       FROM service_order_permissions p
       WHERE p.user_id = :userId AND p.sector_id = :sectorId
         AND p.operation = :operation
         AND NOT EXISTS (
           SELECT 1 FROM service_order_grant_events r
           WHERE r.grant_id = p.grant_id AND r.action = 'REVOKE'
         )`,
      { replacements: { userId, sectorId, operation }, transaction },
    );
    if (existingActive.length > 0)
      throw new Error('Permission grant already active');
    const [targetUser, sector] = await Promise.all([
      User.findByPk(userId, {
        attributes: ['id'],
        transaction,
        lock: transaction.LOCK.SHARE,
      }),
      Sector.findByPk(sectorId, { transaction, lock: transaction.LOCK.SHARE }),
    ]);
    if (!targetUser || !sector)
      throw new Error('Permission target must be an existing sector member');
    const grant = await ServiceOrderOperationGrant.create(
      {
        id: randomUUID(),
        user_id: userId,
        sector_id: sectorId,
        operation,
        granted_by: actorId,
        created_at: new Date(),
        reason: reason.trim(),
      },
      { transaction },
    );
    await ServiceOrderPermission.create(
      {
        grant_id: grant.id,
        user_id: userId,
        sector_id: sectorId,
        operation,
      },
      { transaction },
    );
    await ServiceOrderGrantEventRepository.appendGrantChange({
      transaction,
      grant,
      actorId,
      action: 'GRANT',
      reason,
    });
    return ServiceOrderPermission.findByPk(grant.id, { transaction });
  }

  async revoke({ grantId, actorId, reason }, { transaction } = {}) {
    this.assertTransaction(transaction);
    if (typeof actorId !== 'string' || !actorId.trim())
      throw new Error('Authenticated grant actor is required');
    this.assertReason(reason, 'Permission revocation requires a reason');
    const grant = await ServiceOrderOperationGrant.findByPk(grantId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!grant) return null;
    const revocationCheck = await ServiceOrderOperationGrant.sequelize.query(
      `SELECT 1 FROM service_order_grant_events
       WHERE grant_id=:grantId AND action='REVOKE' LIMIT 1`,
      { replacements: { grantId }, transaction },
    );
    if (revocationCheck[0].length)
      throw new Error('Permission grant is already revoked');
    await ServiceOrderGrantEventRepository.appendGrantChange({
      transaction,
      grant,
      actorId,
      action: 'REVOKE',
      reason,
    });
    const permission = await ServiceOrderPermission.findByPk(grantId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!permission) return null;
    await permission.destroy({ transaction });
    return permission;
  }

  async hasPermission(
    userId,
    sectorId,
    operation,
    { transaction, lock = false } = {},
  ) {
    this.assertOperation(operation);
    if (lock && transaction) {
      await UserSector.findOne({
        where: { user_id: userId, sector_id: sectorId },
        transaction,
        lock: transaction.LOCK.SHARE,
      });
    }
    const [revokedEvents] = await ServiceOrderOperationGrant.sequelize.query(
      `SELECT grant_id FROM service_order_grant_events
       WHERE target_user_id=:userId AND sector_id=:sectorId
         AND operation=:operation AND action='REVOKE'`,
      { replacements: { userId, sectorId, operation }, transaction },
    );
    const revokedIds = revokedEvents.map((event) => event.grant_id);
    const grants = await ServiceOrderPermission.findAll({
      where: { user_id: userId, sector_id: sectorId, operation },
      include: [
        { model: ServiceOrderOperationGrant, as: 'grant', required: true },
      ],
      order: [
        ['grant', 'created_at', 'DESC'],
        ['grant', 'id', 'DESC'],
      ],
      transaction,
      ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    return grants.some(
      (permission) => !revokedIds.includes(permission.grant_id),
    );
  }

  async assertPermission(userId, sectorId, operation, options = {}) {
    const allowed = await this.hasPermission(
      userId,
      sectorId,
      operation,
      options,
    );
    if (!allowed) {
      const error = new Error('ServiceOrder permission denied');
      error.code = 'SERVICE_ORDER_FORBIDDEN';
      throw error;
    }
  }

  assertTransaction(transaction) {
    if (!transaction)
      throw new Error('ServiceOrder permission change requires a transaction');
  }

  assertAdmin(actorId) {
    if (typeof actorId !== 'string' || !actorId.trim())
      throw new Error('Authenticated administrator is required');
  }

  assertReason(reason, message) {
    if (typeof reason !== 'string' || !reason.trim()) throw new Error(message);
  }

  assertOperation(operation) {
    if (!SERVICE_ORDER_OPERATIONS.includes(operation))
      throw new Error('Unknown ServiceOrder operation');
  }
}

export default new ServiceOrderPermissionRepository();
