'use strict';

const EXPECTED_COLUMNS = Object.freeze({
  service_order_operation_grants: [
    'id',
    'user_id',
    'sector_id',
    'operation',
    'granted_by',
    'created_at',
    'reason',
  ],
  service_order_grant_events: [
    'id',
    'grant_id',
    'actor_user_id',
    'target_user_id',
    'sector_id',
    'operation',
    'action',
    'reason',
    'occurred_at',
  ],
  service_order_permissions: ['grant_id', 'user_id', 'sector_id', 'operation'],
  service_order_qualities: [
    'id',
    'service_order_id',
    'product_id',
    'reported_by',
    'inspected_by',
    'issue',
    'disposition',
    'affected_quantity',
    'approved_quantity',
    'rejected_quantity',
    'status',
    'created_at',
  ],
  service_orders: [
    'id',
    'external_number',
    'client_id',
    'sector_id',
    'due_at',
    'public_status',
    'administrative_state',
    'operational_version',
    'queue_entered_at',
    'production_completed',
    'created_by',
    'created_at',
    'updated_at',
  ],
});

async function readRows(queryInterface, sql, options = {}) {
  const result = await queryInterface.sequelize.query(sql, options);
  return Array.isArray(result?.[0]) ? result[0] : result;
}

async function assertBaseline(queryInterface, transaction) {
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const relation = await readRows(
      queryInterface,
      'SELECT to_regclass(:name) AS relation',
      { replacements: { name: `public.${table}` }, transaction },
    );
    if (!relation[0]?.relation)
      throw new Error(`Refusing Feature 004 extension: missing ${table}`);
    const rows = await readRows(
      queryInterface,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = :table
       ORDER BY ordinal_position`,
      { replacements: { table }, transaction },
    );
    const actual = rows.map((row) => row.column_name);
    const partial =
      table === 'service_orders'
        ? ['notes']
        : table === 'service_order_qualities'
          ? ['rework_executor_id', 'inspection_history']
          : [];
    const allowed = expected.concat(
      partial.filter((column) => actual.includes(column)),
    );
    // 190 creates these columns inline; the historical recovery appended them.
    const inline = [...expected];
    if (table === 'service_orders' && actual.includes('notes'))
      inline.splice(inline.indexOf('public_status'), 0, 'notes');
    if (table === 'service_order_qualities')
      inline.splice(
        inline.indexOf('issue'),
        0,
        ...partial.filter((column) => actual.includes(column)),
      );
    if (
      actual.join('|') !== allowed.join('|') &&
      actual.join('|') !== inline.join('|')
    )
      throw new Error(
        `Refusing Feature 004 extension: unexpected ${table} columns`,
      );
  }

  const trigger = await readRows(
    queryInterface,
    `SELECT pg_get_triggerdef(t.oid) AS definition
     FROM pg_trigger t
     WHERE t.tgrelid = 'service_order_operation_grants'::regclass
       AND t.tgname = 'service_order_grants_append_only'`,
    { transaction },
  );
  if (
    trigger.length !== 1 ||
    !trigger[0].definition.includes('DELETE') ||
    trigger[0].definition.includes('UPDATE')
  )
    throw new Error('Refusing Feature 004 extension: unexpected grant trigger');

  const indexes = await readRows(
    queryInterface,
    `SELECT indexname,indexdef
     FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname IN (
         'service_order_grants_ever_uq',
         'service_order_permissions_active_uq'
       )`,
    { transaction },
  );
  const grantIndex = indexes.find(
    (row) => row.indexname === 'service_order_grants_ever_uq',
  );
  const permissionIndex = indexes.find(
    (row) => row.indexname === 'service_order_permissions_active_uq',
  );
  if (
    !grantIndex?.indexdef.includes('(user_id, sector_id, operation)') ||
    !permissionIndex?.indexdef.includes('(user_id, sector_id, operation)')
  )
    throw new Error(
      'Refusing Feature 004 extension: unexpected authorization indexes',
    );

  const counts = await readRows(
    queryInterface,
    `SELECT
       (SELECT count(*) FROM service_order_operation_grants) AS grants,
       (SELECT count(*) FROM service_order_grant_events) AS events,
       (SELECT count(*) FROM service_order_permissions) AS permissions`,
    { transaction },
  );
  if (
    Number(counts[0].grants) ||
    Number(counts[0].events) ||
    Number(counts[0].permissions)
  )
    throw new Error(
      'Refusing Feature 004 extension: authorization data is non-empty',
    );
}

module.exports = {
  async up(queryInterface) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await assertBaseline(queryInterface, transaction);
      await queryInterface.sequelize.query(
        `CREATE EXTENSION IF NOT EXISTS pgcrypto;
         ALTER TABLE service_order_grant_events
           ADD COLUMN IF NOT EXISTS audit_hash VARCHAR(64) NOT NULL DEFAULT repeat('0',64),
           ADD COLUMN IF NOT EXISTS audit_previous_hash VARCHAR(64) NOT NULL DEFAULT repeat('0',64);
         ALTER TABLE service_order_grant_events
           ALTER COLUMN audit_hash DROP DEFAULT,
           ALTER COLUMN audit_previous_hash DROP DEFAULT;
         CREATE OR REPLACE FUNCTION set_service_order_grant_event_hash()
         RETURNS trigger AS $$
         DECLARE prior_hash VARCHAR(64);
         BEGIN
           PERFORM pg_advisory_xact_lock(hashtextextended(NEW.grant_id::text,0));
           SELECT audit_hash INTO prior_hash FROM service_order_grant_events
           WHERE grant_id=NEW.grant_id ORDER BY occurred_at DESC,id DESC LIMIT 1;
           NEW.audit_previous_hash:=COALESCE(prior_hash,repeat('0',64));
           IF NEW.audit_hash<>repeat('0',64) THEN RAISE EXCEPTION 'grant event hash is database-generated'; END IF;
           NEW.audit_hash:=encode(digest(NEW.id::text||':'||NEW.grant_id::text||':'||NEW.actor_user_id::text||':'||NEW.target_user_id::text||':'||NEW.sector_id::text||':'||NEW.operation||':'||NEW.action||':'||NEW.reason||':'||NEW.occurred_at::text||':'||NEW.audit_previous_hash,'sha256'),'hex');
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql;
         CREATE TRIGGER service_order_grant_event_hash_before_insert BEFORE INSERT ON service_order_grant_events FOR EACH ROW EXECUTE FUNCTION set_service_order_grant_event_hash();
         ALTER TABLE service_order_grant_events ADD CONSTRAINT service_order_grant_events_action_ck CHECK(action IN ('GRANT','REVOKE'));
         DROP INDEX IF EXISTS service_order_grants_ever_uq;
         CREATE INDEX IF NOT EXISTS service_order_grants_lookup_idx
           ON service_order_operation_grants(user_id, sector_id, operation);`,
        { transaction },
      );
    });
  },

  async down() {
    throw new Error(
      'Feature 004 extension is forward-only; preserve schema and audit history',
    );
  },
};
