'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        ALTER TABLE service_orders ADD COLUMN functional_status varchar(32);
        CREATE TABLE service_order_responsibilities (
          id uuid PRIMARY KEY,
          service_order_id uuid NOT NULL REFERENCES service_orders(id) ON DELETE RESTRICT,
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          assigned_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          released_by uuid NULL REFERENCES users(id) ON DELETE RESTRICT,
          assigned_at timestamptz NOT NULL,
          released_at timestamptz NULL,
          release_reason varchar(1000) NULL,
          CONSTRAINT service_order_responsibility_release_pair_ck
            CHECK ((released_at IS NULL) = (released_by IS NULL))
        );
        CREATE UNIQUE INDEX service_order_responsibility_one_per_order_uq
          ON service_order_responsibilities(service_order_id) WHERE released_at IS NULL;
        CREATE UNIQUE INDEX service_order_responsibility_one_per_user_uq
          ON service_order_responsibilities(user_id) WHERE released_at IS NULL;
        CREATE INDEX service_order_responsibility_history_idx
          ON service_order_responsibilities(service_order_id, assigned_at, id);
        CREATE FUNCTION reject_service_order_responsibility_delete()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'service order responsibility history is append-only'; END;
        $$;
        CREATE TRIGGER service_order_responsibilities_no_delete
          BEFORE DELETE ON service_order_responsibilities
          FOR EACH ROW EXECUTE FUNCTION reject_service_order_responsibility_delete();
        CREATE TRIGGER service_order_responsibilities_no_truncate
          BEFORE TRUNCATE ON service_order_responsibilities
          FOR EACH STATEMENT EXECUTE FUNCTION reject_service_order_responsibility_delete();
      `,
        { transaction },
      );
    });
  },

  async down() {
    throw new Error(
      'Destructive Feature 004 responsibility rollback is prohibited',
    );
  },
};
