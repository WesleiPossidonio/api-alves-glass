'use strict';

const operations = "'CREATE_EDIT','READ','REPLACE_PDF','PUBLISH','DELETE','MANAGE_PERMISSIONS'";
const previous = '20261126000000-add-service-order-informational-priority.cjs';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const [rows] = await queryInterface.sequelize.query(
        'SELECT name FROM public."SequelizeMeta" WHERE name = :previous',
        { transaction, replacements: { previous } },
      );
      if (rows.length !== 1) throw new Error('BUDGET_MIGRATION_PREREQUISITE');
      await queryInterface.sequelize.query(`
        CREATE TABLE public.budget_commercial_managers (
          user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          sector_id uuid NOT NULL REFERENCES public.sectors(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          appointed_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, sector_id),
          CONSTRAINT budget_managers_no_self_ck CHECK (user_id <> appointed_by)
        );
        CREATE INDEX budget_managers_sector_idx ON public.budget_commercial_managers(sector_id);
        CREATE INDEX budget_managers_actor_idx ON public.budget_commercial_managers(appointed_by);
        CREATE TABLE public.budget_commercial_permissions (
          user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          sector_id uuid NOT NULL REFERENCES public.sectors(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          operation text NOT NULL CHECK (operation IN (${operations})),
          granted_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, sector_id, operation),
          CONSTRAINT budget_permissions_no_self_ck CHECK (user_id <> granted_by)
        );
        CREATE INDEX budget_permissions_sector_idx ON public.budget_commercial_permissions(sector_id);
        CREATE INDEX budget_permissions_actor_idx ON public.budget_commercial_permissions(granted_by);
        CREATE TABLE public.budget_commercial_permission_audit (
          id uuid PRIMARY KEY,
          actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          target_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          sector_id uuid NOT NULL REFERENCES public.sectors(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          action text NOT NULL CHECK (action IN ('APPOINT_MANAGER','REVOKE_MANAGER','GRANT','REVOKE')),
          operation text CHECK (operation IN (${operations})),
          occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT budget_audit_operation_ck CHECK (
            (action IN ('APPOINT_MANAGER','REVOKE_MANAGER') AND operation IS NULL)
            OR (action IN ('GRANT','REVOKE') AND operation IS NOT NULL)
          ),
          CONSTRAINT budget_audit_no_self_grant_ck CHECK (
            action NOT IN ('APPOINT_MANAGER','GRANT') OR actor_user_id <> target_user_id
          )
        );
        CREATE INDEX budget_audit_actor_idx ON public.budget_commercial_permission_audit(actor_user_id);
        CREATE INDEX budget_audit_target_idx ON public.budget_commercial_permission_audit(target_user_id);
        CREATE INDEX budget_audit_sector_time_idx ON public.budget_commercial_permission_audit(sector_id, occurred_at, id);
        CREATE FUNCTION public.budget_permission_audit_append_only() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN
            RAISE EXCEPTION 'BUDGET_PERMISSION_AUDIT_APPEND_ONLY' USING ERRCODE = '23514';
          END $$;
        CREATE TRIGGER budget_permission_audit_no_mutation
          BEFORE UPDATE OR DELETE ON public.budget_commercial_permission_audit
          FOR EACH ROW EXECUTE FUNCTION public.budget_permission_audit_append_only();
        CREATE TRIGGER budget_permission_audit_no_truncate
          BEFORE TRUNCATE ON public.budget_commercial_permission_audit
          FOR EACH STATEMENT EXECUTE FUNCTION public.budget_permission_audit_append_only();
      `, { transaction });
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`LOCK TABLE public.budget_commercial_managers,
        public.budget_commercial_permissions, public.budget_commercial_permission_audit
        IN ACCESS EXCLUSIVE MODE`, { transaction });
      const [rows] = await queryInterface.sequelize.query(`SELECT (
        EXISTS(SELECT 1 FROM public.budget_commercial_managers)
        OR EXISTS(SELECT 1 FROM public.budget_commercial_permissions)
        OR EXISTS(SELECT 1 FROM public.budget_commercial_permission_audit)
      ) AS populated`, { transaction });
      if (rows[0].populated) throw new Error('BUDGET_ROLLBACK_REQUIRES_EMPTY_TABLES');
      await queryInterface.sequelize.query(`
        DROP TABLE public.budget_commercial_permission_audit;
        DROP FUNCTION public.budget_permission_audit_append_only();
        DROP TABLE public.budget_commercial_permissions;
        DROP TABLE public.budget_commercial_managers;
      `, { transaction });
    });
  },
};