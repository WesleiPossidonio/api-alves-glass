'use strict';

const previous = '20261128000000-create-budget-pdf-objects.cjs';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const [rows] = await queryInterface.sequelize.query(
        'SELECT name FROM public."SequelizeMeta" WHERE name = :previous',
        { transaction, replacements: { previous } },
      );
      if (rows.length !== 1) throw new Error('BUDGET_MIGRATION_PREREQUISITE');
      await queryInterface.sequelize.query(`
        CREATE TABLE public.budgets_pdf (
          id uuid PRIMARY KEY,
          client_id uuid NOT NULL REFERENCES public.client(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          sector_id uuid NOT NULL REFERENCES public.sectors(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          commercial_number varchar(64) COLLATE "C" NOT NULL,
          administrative_name varchar(240) NOT NULL,
          revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
          first_published_at timestamptz,
          published_object_id uuid,
          published_validity_date date,
          pending_object_id uuid,
          pending_validity_date date,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT budgets_pdf_number_ck CHECK (
            length(commercial_number) > 0 AND commercial_number !~ '[[:cntrl:]]'
            AND commercial_number !~ '^[[:space:]]|[[:space:]]$'
          ),
          CONSTRAINT budgets_pdf_name_ck CHECK (
            administrative_name ~ '[^[:space:]]' AND administrative_name !~ '[[:cntrl:]]'
          ),
          CONSTRAINT budgets_pdf_number_uq UNIQUE (sector_id, commercial_number),
          CONSTRAINT budgets_pdf_pending_pair_ck CHECK ((pending_object_id IS NULL) = (pending_validity_date IS NULL)),
          CONSTRAINT budgets_pdf_published_pair_ck CHECK ((published_object_id IS NULL) = (published_validity_date IS NULL)),
          CONSTRAINT budgets_pdf_slot_required_ck CHECK (pending_object_id IS NOT NULL OR published_object_id IS NOT NULL),
          CONSTRAINT budgets_pdf_distinct_slots_ck CHECK (pending_object_id IS NULL OR published_object_id IS NULL OR pending_object_id <> published_object_id),
          CONSTRAINT budgets_pdf_publication_pair_ck CHECK ((published_object_id IS NULL) = (first_published_at IS NULL)),
          CONSTRAINT budgets_pdf_pending_date_ck CHECK (pending_validity_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
          CONSTRAINT budgets_pdf_published_date_ck CHECK (published_validity_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
          CONSTRAINT budgets_pdf_pending_owner_fk FOREIGN KEY (pending_object_id, id)
            REFERENCES public.budget_pdf_objects(id, owner_budget_id)
            ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
          CONSTRAINT budgets_pdf_published_owner_fk FOREIGN KEY (published_object_id, id)
            REFERENCES public.budget_pdf_objects(id, owner_budget_id)
            ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
        );
        CREATE UNIQUE INDEX budgets_pdf_pending_slot_uq ON public.budgets_pdf(pending_object_id) WHERE pending_object_id IS NOT NULL;
        CREATE UNIQUE INDEX budgets_pdf_published_slot_uq ON public.budgets_pdf(published_object_id) WHERE published_object_id IS NOT NULL;
        CREATE INDEX budgets_pdf_sector_keyset_idx ON public.budgets_pdf(sector_id, created_at DESC, id DESC);
        CREATE INDEX budgets_pdf_client_keyset_idx ON public.budgets_pdf(client_id, created_at DESC, id DESC) WHERE published_object_id IS NOT NULL;
        CREATE INDEX budgets_pdf_client_fk_idx ON public.budgets_pdf(client_id);
        CREATE INDEX budgets_pdf_creator_idx ON public.budgets_pdf(created_by);
        CREATE FUNCTION public.budget_pdf_publication_marker_guard() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN
            IF OLD.first_published_at IS NOT NULL
               AND NEW.first_published_at IS DISTINCT FROM OLD.first_published_at THEN
              RAISE EXCEPTION 'BUDGET_PUBLICATION_MARKER_IMMUTABLE' USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
          END $$;
        CREATE TRIGGER budgets_pdf_publication_marker_guard BEFORE UPDATE ON public.budgets_pdf
          FOR EACH ROW EXECUTE FUNCTION public.budget_pdf_publication_marker_guard();
      `, { transaction });
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        'LOCK TABLE public.budgets_pdf, public.budget_pdf_objects IN ACCESS EXCLUSIVE MODE', { transaction },
      );
      const [rows] = await queryInterface.sequelize.query(`SELECT (
        EXISTS(SELECT 1 FROM public.budgets_pdf) OR EXISTS(SELECT 1 FROM public.budget_pdf_objects)
      ) AS populated`, { transaction });
      if (rows[0].populated) throw new Error('BUDGET_ROLLBACK_REQUIRES_EMPTY_TABLES');
      await queryInterface.sequelize.query(`DROP TABLE public.budgets_pdf;
        DROP FUNCTION public.budget_pdf_publication_marker_guard()`, { transaction });
    });
  },
};