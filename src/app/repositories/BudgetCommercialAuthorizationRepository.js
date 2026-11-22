import { QueryTypes } from 'sequelize';
import BudgetCommercialManager from '../models/BudgetCommercialManager.js';
import BudgetCommercialPermission from '../models/BudgetCommercialPermission.js';
import BudgetCommercialPermissionAudit from '../models/BudgetCommercialPermissionAudit.js';
import { requireBudgetTransaction } from './BudgetPdfRepository.js';

export class BudgetCommercialAuthorizationRepositoryClient {
  constructor({
    manager = BudgetCommercialManager,
    permission = BudgetCommercialPermission,
    audit = BudgetCommercialPermissionAudit,
  } = {}) {
    this.manager = manager;
    this.permission = permission;
    this.audit = audit;
  }
  query(sql, replacements, transaction) {
    requireBudgetTransaction(transaction);
    return this.manager.sequelize.query(sql, {
      replacements,
      transaction,
      type: QueryTypes.SELECT,
    });
  }
  async lockAuthorizationGuards(keys, transaction, { shared = false } = {}) {
    for (const key of [...new Set(keys)].sort()) {
      await this.query(
        `SELECT pg_advisory_xact_lock${shared ? '_shared' : ''}(hashtextextended(:key,0))`,
        { key: `budget-auth:${key}` },
        transaction,
      );
    }
  }
  async readAuthorizationSnapshot(
    { actorId, sectorId, targetUserId },
    transaction,
  ) {
    const snapshots = new Map();
    // User rows, then existing membership rows, in deterministic identity order.
    const users = new Map();
    const ids = [...new Set([actorId, targetUserId].filter(Boolean))].sort();
    for (const id of ids) {
      const [user] = await this.query(
        'SELECT id,role,status_users FROM public.users WHERE id=:id FOR SHARE',
        { id },
        transaction,
      );
      users.set(id, user);
    }
    for (const id of ids) {
      const members = await this.query(
        'SELECT user_id FROM public.user_sectors WHERE user_id=:id AND sector_id=:sectorId FOR SHARE',
        { id, sectorId },
        transaction,
      );
      const managers = await this.query(
        'SELECT user_id FROM public.budget_commercial_managers WHERE user_id=:id AND sector_id=:sectorId',
        { id, sectorId },
        transaction,
      );
      const operations = await this.query(
        'SELECT operation FROM public.budget_commercial_permissions WHERE user_id=:id AND sector_id=:sectorId',
        { id, sectorId },
        transaction,
      );
      snapshots.set(id, {
        ...users.get(id),
        isMember: members.length === 1,
        isManager: managers.length === 1,
        operations: operations.map((row) => row.operation),
      });
    }
    const actor = snapshots.get(actorId) ?? {
      isMember: false,
      isManager: false,
      operations: [],
    };
    return {
      actor: users.get(actorId),
      isMember: actor.isMember,
      isManager: actor.isManager,
      operations: actor.operations,
      target: targetUserId ? snapshots.get(targetUserId) : undefined,
    };
  }
  appoint(values, transaction) {
    requireBudgetTransaction(transaction);
    return this.manager.create(values, { transaction });
  }
  revokeManager(userId, sectorId, transaction) {
    requireBudgetTransaction(transaction);
    return this.manager.destroy({
      where: { user_id: userId, sector_id: sectorId },
      transaction,
    });
  }
  grant(values, transaction) {
    requireBudgetTransaction(transaction);
    return this.permission.create(values, { transaction });
  }
  revoke(userId, sectorId, operation, transaction) {
    requireBudgetTransaction(transaction);
    return this.permission.destroy({
      where: { user_id: userId, sector_id: sectorId, operation },
      transaction,
    });
  }
  appendAudit(values, transaction) {
    requireBudgetTransaction(transaction);
    return this.audit.create(values, { transaction });
  }
  async listGrants(sectorId, transaction) {
    return this.query(
      `SELECT p.user_id AS "userId",p.operation, (u.status_users='active' AND s.user_id IS NOT NULL) AS effective
       FROM public.budget_commercial_permissions p
       JOIN public.users u ON u.id=p.user_id
       LEFT JOIN public.user_sectors s ON s.user_id=p.user_id AND s.sector_id=p.sector_id
       WHERE p.sector_id=:sectorId ORDER BY p.user_id,p.operation`,
      { sectorId },
      transaction,
    );
  }
  async listManagers(sectorId, transaction) {
    return this.query(
      `SELECT m.user_id AS "userId", (u.status_users='active' AND s.user_id IS NOT NULL) AS effective
       FROM public.budget_commercial_managers m
       JOIN public.users u ON u.id=m.user_id
       LEFT JOIN public.user_sectors s ON s.user_id=m.user_id AND s.sector_id=m.sector_id
       WHERE m.sector_id=:sectorId ORDER BY m.user_id`,
      { sectorId },
      transaction,
    );
  }
}
export default new BudgetCommercialAuthorizationRepositoryClient();
