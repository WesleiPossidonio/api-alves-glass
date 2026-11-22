'use strict';

const previous = '20261127000000-create-budget-commercial-authorization.cjs';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const [rows] = await queryInterface.sequelize.query(
        'SELECT name FROM public."SequelizeMeta" WHERE name = :previous',
        { transaction, replacements: { previous } },
      );
      if (rows.length !== 1) throw new Error('BUDGET_MIGRATION_PREREQUISITE');
      await queryInterface.sequelize.query(`
        CREATE TABLE public.budget_pdf_objects (
          id uuid PRIMARY KEY,
          owner_budget_id uuid NOT NULL,
          bucket varchar(255) NOT NULL CHECK (length(bucket) > 0),
          object_key text NOT NULL CHECK (length(object_key) > 0),
          created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          state text NOT NULL CHECK (state IN ('UPLOADING','READY','ATTACHED','CLEANUP_PENDING','CLEANING','REMOVED')),
          size_bytes bigint CHECK (size_bytes > 0 AND size_bytes <= 10485760),
          sha256 char(64) CHECK (sha256 ~ '^[0-9a-f]{64}$'),
          content_type text CHECK (content_type = 'application/pdf'),
          validity_date date NOT NULL CHECK (validity_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
          expected_revision bigint CHECK (expected_revision > 0),
          lease_token uuid,
          lease_until timestamptz,
          attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_error_code varchar(128),
          confirmed_at timestamptz,
          removed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT budget_objects_owner_uq UNIQUE (id, owner_budget_id),
          CONSTRAINT budget_objects_key_uq UNIQUE (bucket, object_key),
          CONSTRAINT budget_objects_lease_pair_ck CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
          CONSTRAINT budget_objects_active_lease_ck CHECK (
            state NOT IN ('UPLOADING','CLEANING') OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)
          ),
          CONSTRAINT budget_objects_ready_ck CHECK (
            state NOT IN ('READY','ATTACHED') OR (
              size_bytes IS NOT NULL AND sha256 IS NOT NULL
              AND content_type IS NOT NULL AND confirmed_at IS NOT NULL
            )
          ),
          CONSTRAINT budget_objects_removed_ck CHECK ((state = 'REMOVED') = (removed_at IS NOT NULL))
        );
        CREATE INDEX budget_objects_cleanup_idx ON public.budget_pdf_objects(state, next_attempt_at, id)
          WHERE state IN ('CLEANUP_PENDING','CLEANING');
        CREATE INDEX budget_objects_expired_upload_idx ON public.budget_pdf_objects(lease_until, id)
          WHERE state = 'UPLOADING';
        CREATE INDEX budget_objects_owner_idx ON public.budget_pdf_objects(owner_budget_id);
        CREATE INDEX budget_objects_creator_idx ON public.budget_pdf_objects(created_by);
      `, { transaction });
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query('LOCK TABLE public.budget_pdf_objects IN ACCESS EXCLUSIVE MODE', { transaction });
      const [rows] = await queryInterface.sequelize.query(
        'SELECT EXISTS(SELECT 1 FROM public.budget_pdf_objects) AS populated', { transaction },
      );
      if (rows[0].populated) throw new Error('BUDGET_ROLLBACK_REQUIRES_EMPTY_TABLES');
      await queryInterface.sequelize.query('DROP TABLE public.budget_pdf_objects', { transaction });
    });
  },
};