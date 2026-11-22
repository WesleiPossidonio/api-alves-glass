'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const [rows] = await queryInterface.sequelize.query(
        'SELECT name FROM public."SequelizeMeta" WHERE name = :previous',
        {
          transaction,
          replacements: { previous: '20261129000000-create-budgets-pdf.cjs' },
        },
      );
      if (rows.length !== 1) throw new Error('BUDGET_MIGRATION_PREREQUISITE');
      await queryInterface.sequelize.query(
        `
        CREATE FUNCTION public.budget_pdf_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE object_id uuid; object_state text; object_revision bigint; object_validity date;
        BEGIN
          IF TG_OP = 'INSERT' THEN
            IF NEW.revision <> 1 THEN
              RAISE EXCEPTION 'BUDGET_INITIAL_REVISION' USING ERRCODE='23514';
            END IF;
          ELSE
            IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_by IS DISTINCT FROM OLD.created_by
               OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
              RAISE EXCEPTION 'BUDGET_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
            END IF;
            IF NEW.revision <> OLD.revision + 1 THEN
              RAISE EXCEPTION 'BUDGET_REVISION_INCREMENT_REQUIRED' USING ERRCODE='23514';
            END IF;
            IF OLD.first_published_at IS NOT NULL AND (
              NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.sector_id IS DISTINCT FROM OLD.sector_id
              OR NEW.commercial_number IS DISTINCT FROM OLD.commercial_number
              OR NEW.first_published_at IS DISTINCT FROM OLD.first_published_at
            ) THEN
              RAISE EXCEPTION 'BUDGET_PUBLISHED_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
            END IF;
            IF (NEW.published_object_id IS NOT DISTINCT FROM OLD.published_object_id
                AND NEW.published_validity_date IS DISTINCT FROM OLD.published_validity_date)
               OR (OLD.first_published_at IS NOT NULL
                AND NEW.pending_object_id IS NOT DISTINCT FROM OLD.pending_object_id
                AND NEW.pending_object_id IS NOT NULL
                AND NEW.pending_validity_date IS DISTINCT FROM OLD.pending_validity_date) THEN
              RAISE EXCEPTION 'BUDGET_REPLACEMENT_PDF_REQUIRED' USING ERRCODE='23514';
            END IF;
          END IF;
          -- Publication only moves the current pending pair, never an arbitrary registry ID.
          IF NEW.published_object_id IS NOT NULL AND
             (TG_OP = 'INSERT' OR NEW.published_object_id IS DISTINCT FROM OLD.published_object_id) THEN
            IF TG_OP = 'INSERT' OR NEW.published_object_id IS DISTINCT FROM OLD.pending_object_id
               OR NEW.published_validity_date IS DISTINCT FROM OLD.pending_validity_date
               OR NEW.pending_object_id IS NOT NULL THEN
              RAISE EXCEPTION 'BUDGET_PUBLICATION_REQUIRES_PENDING_PAIR' USING ERRCODE='23514';
            END IF;
          END IF;
          -- Existing references (including pending -> published) may remain ATTACHED.
          FOR object_id IN SELECT value FROM unnest(ARRAY[NEW.pending_object_id,NEW.published_object_id]) value
            WHERE value IS NOT NULL ORDER BY value
          LOOP
            IF TG_OP = 'INSERT' OR (object_id IS DISTINCT FROM OLD.pending_object_id
                AND object_id IS DISTINCT FROM OLD.published_object_id) THEN
              SELECT state,expected_revision,validity_date INTO object_state,object_revision,object_validity FROM public.budget_pdf_objects
                WHERE id=object_id AND owner_budget_id=NEW.id FOR UPDATE;
              IF object_state IS DISTINCT FROM 'READY' THEN
                RAISE EXCEPTION 'BUDGET_OBJECT_NOT_READY' USING ERRCODE='23514';
              END IF;
              IF (TG_OP='INSERT' AND object_revision IS NOT NULL)
                 OR (TG_OP='UPDATE' AND object_revision IS DISTINCT FROM OLD.revision)
                 OR (object_id=NEW.pending_object_id AND object_validity IS DISTINCT FROM NEW.pending_validity_date) THEN
                RAISE EXCEPTION 'BUDGET_OBJECT_REVISION_OR_VALIDITY_MISMATCH' USING ERRCODE='23514';
              END IF;
            END IF;
          END LOOP;
          RETURN NEW;
        END $$;
        CREATE TRIGGER budgets_pdf_identity_guard BEFORE INSERT OR UPDATE ON public.budgets_pdf
          FOR EACH ROW EXECUTE FUNCTION public.budget_pdf_identity_guard();

        CREATE FUNCTION public.budget_pdf_object_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'BUDGET_OBJECT_REGISTRY_MUST_SURVIVE' USING ERRCODE='23514';
          END IF;
          IF TG_OP = 'INSERT' THEN
            IF NEW.state <> 'UPLOADING' THEN
              RAISE EXCEPTION 'BUDGET_OBJECT_INITIAL_STATE' USING ERRCODE='23514';
            END IF;
            RETURN NEW;
          END IF;
          IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_budget_id IS DISTINCT FROM OLD.owner_budget_id
             OR NEW.bucket IS DISTINCT FROM OLD.bucket OR NEW.object_key IS DISTINCT FROM OLD.object_key
             OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
             OR NEW.expected_revision IS DISTINCT FROM OLD.expected_revision THEN
            RAISE EXCEPTION 'BUDGET_OBJECT_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
          END IF;
          IF OLD.confirmed_at IS NOT NULL AND (
            NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.sha256 IS DISTINCT FROM OLD.sha256
            OR NEW.content_type IS DISTINCT FROM OLD.content_type OR NEW.validity_date IS DISTINCT FROM OLD.validity_date
            OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
          ) THEN
            RAISE EXCEPTION 'BUDGET_OBJECT_METADATA_IMMUTABLE' USING ERRCODE='23514';
          END IF;
          IF NEW.state <> OLD.state AND NOT (
            (OLD.state='UPLOADING' AND NEW.state IN ('READY','CLEANUP_PENDING')) OR
            (OLD.state='READY' AND NEW.state IN ('ATTACHED','CLEANUP_PENDING')) OR
            (OLD.state='ATTACHED' AND NEW.state='CLEANUP_PENDING') OR
            (OLD.state='CLEANUP_PENDING' AND NEW.state='CLEANING') OR
            (OLD.state='CLEANING' AND NEW.state IN ('CLEANUP_PENDING','REMOVED')) OR
            (OLD.state='REMOVED' AND NEW.state='CLEANUP_PENDING')
          ) THEN
            RAISE EXCEPTION 'BUDGET_OBJECT_TRANSITION_INVALID' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER budget_objects_lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON public.budget_pdf_objects
          FOR EACH ROW EXECUTE FUNCTION public.budget_pdf_object_guard();
        CREATE FUNCTION public.budget_pdf_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'BUDGET_TRUNCATE_FORBIDDEN' USING ERRCODE='23514';
        END $$;
        CREATE TRIGGER budgets_pdf_no_truncate BEFORE TRUNCATE ON public.budgets_pdf
          FOR EACH STATEMENT EXECUTE FUNCTION public.budget_pdf_no_truncate();
        CREATE TRIGGER budget_objects_no_truncate BEFORE TRUNCATE ON public.budget_pdf_objects
          FOR EACH STATEMENT EXECUTE FUNCTION public.budget_pdf_no_truncate();

        -- Read final current rows, not event snapshots: multiple updates may occur in one transaction.
        CREATE FUNCTION public.budget_pdf_assert_owner(owner_id uuid) RETURNS void LANGUAGE plpgsql AS $$
        DECLARE b public.budgets_pdf%ROWTYPE;
        BEGIN
          SELECT * INTO b FROM public.budgets_pdf WHERE id=owner_id;
          IF FOUND AND EXISTS (
            SELECT 1 FROM unnest(ARRAY[b.pending_object_id,b.published_object_id]) slot
            LEFT JOIN public.budget_pdf_objects o ON o.id=slot
            WHERE slot IS NOT NULL AND (o.id IS NULL OR o.owner_budget_id<>b.id OR o.state<>'ATTACHED')
          ) THEN
            RAISE EXCEPTION 'BUDGET_SLOT_REQUIRES_ATTACHED_OBJECT' USING ERRCODE='23514';
          END IF;
          IF EXISTS (
            SELECT 1 FROM public.budget_pdf_objects o WHERE o.owner_budget_id=owner_id AND (
              (o.state='ATTACHED') IS DISTINCT FROM EXISTS(
                SELECT 1 FROM public.budgets_pdf p WHERE p.id=owner_id
                  AND (p.pending_object_id=o.id OR p.published_object_id=o.id)
              )
            )
          ) THEN
            RAISE EXCEPTION 'BUDGET_OBJECT_REFERENCE_STATE_MISMATCH' USING ERRCODE='23514';
          END IF;
        END $$;
        CREATE FUNCTION public.budget_pdf_deferred_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_TABLE_NAME='budgets_pdf' THEN
            IF TG_OP='DELETE' THEN PERFORM public.budget_pdf_assert_owner(OLD.id);
            ELSE PERFORM public.budget_pdf_assert_owner(NEW.id); END IF;
          ELSE
            PERFORM public.budget_pdf_assert_owner(NEW.owner_budget_id);
          END IF;
          RETURN NULL;
        END $$;
        CREATE CONSTRAINT TRIGGER budgets_pdf_final_integrity AFTER INSERT OR UPDATE OR DELETE ON public.budgets_pdf
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.budget_pdf_deferred_integrity();
        CREATE CONSTRAINT TRIGGER budget_objects_final_integrity AFTER INSERT OR UPDATE ON public.budget_pdf_objects
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.budget_pdf_deferred_integrity();
      `,
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        'LOCK TABLE public.budgets_pdf, public.budget_pdf_objects IN ACCESS EXCLUSIVE MODE',
        { transaction },
      );
      const [rows] = await queryInterface.sequelize.query(
        `SELECT (
        EXISTS(SELECT 1 FROM public.budgets_pdf) OR EXISTS(SELECT 1 FROM public.budget_pdf_objects)
      ) AS populated`,
        { transaction },
      );
      if (rows[0].populated)
        throw new Error('BUDGET_ROLLBACK_REQUIRES_EMPTY_TABLES');
      await queryInterface.sequelize.query(
        `
        DROP TRIGGER budgets_pdf_final_integrity ON public.budgets_pdf;
        DROP TRIGGER budget_objects_final_integrity ON public.budget_pdf_objects;
        DROP TRIGGER budgets_pdf_identity_guard ON public.budgets_pdf;
        DROP TRIGGER budget_objects_lifecycle_guard ON public.budget_pdf_objects;
        DROP TRIGGER budgets_pdf_no_truncate ON public.budgets_pdf;
        DROP TRIGGER budget_objects_no_truncate ON public.budget_pdf_objects;
        DROP FUNCTION public.budget_pdf_no_truncate();
        DROP FUNCTION public.budget_pdf_deferred_integrity();
        DROP FUNCTION public.budget_pdf_assert_owner(uuid);
        DROP FUNCTION public.budget_pdf_identity_guard();
        DROP FUNCTION public.budget_pdf_object_guard();
      `,
        { transaction },
      );
    });
  },
};
