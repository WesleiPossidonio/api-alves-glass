'use strict';

const EXPECTED = {
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
    'notes',
  ],
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
    'rework_executor_id',
    'inspection_history',
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
    'audit_hash',
    'audit_previous_hash',
  ],
};

async function queryRows(qi, sql, options = {}) {
  const result = await qi.sequelize.query(sql, options);
  return Array.isArray(result?.[0]) ? result[0] : result;
}

async function assertRepairState(qi, tx) {
  const meta = await queryRows(
    qi,
    'SELECT name FROM "SequelizeMeta" WHERE name IN (:baseline,:extension)',
    {
      replacements: {
        baseline: '20261119000000-create-service-orders.cjs',
        extension: '20261120000000-extend-service-order-schema.cjs',
      },
      transaction: tx,
    },
  );
  const applied = new Set(meta.map((row) => row.name));
  if (
    !applied.has('20261119000000-create-service-orders.cjs') ||
    !applied.has('20261120000000-extend-service-order-schema.cjs')
  )
    throw new Error('Repair requires OS baseline and extension metadata');

  for (const [table, expected] of Object.entries(EXPECTED)) {
    const actual = await queryRows(
      qi,
      'SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=:table ORDER BY ordinal_position',
      { replacements: { table }, transaction: tx },
    );
    if (actual.map((row) => row.column_name).join('|') !== expected.join('|'))
      throw new Error(`Repair baseline columns mismatch: ${table}`);
  }

  const partial = await queryRows(
    qi,
    "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name='service_orders' AND column_name='notes') OR (table_name='service_order_qualities' AND column_name IN ('rework_executor_id','inspection_history'))) ORDER BY table_name,column_name",
    { transaction: tx },
  );
  const partialNames = partial
    .map((row) => `${row.table_name}.${row.column_name}`)
    .sort()
    .join('|');
  const expectedPartial = [
    'service_order_qualities.inspection_history',
    'service_order_qualities.rework_executor_id',
    'service_orders.notes',
  ]
    .sort()
    .join('|');
  if (partialNames !== expectedPartial)
    throw new Error('Repair extension-column state mismatch');

  const triggers = await queryRows(
    qi,
    "SELECT pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t WHERE t.tgrelid='service_order_operation_grants'::regclass AND t.tgname='service_order_grants_append_only'",
    { transaction: tx },
  );
  if (
    triggers.length !== 1 ||
    !triggers[0].definition.includes('DELETE') ||
    triggers[0].definition.includes('UPDATE')
  )
    throw new Error('Repair grant trigger state mismatch');

  const indexes = await queryRows(
    qi,
    "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('service_order_grants_lookup_idx','service_order_permissions_active_uq')",
    { transaction: tx },
  );
  if (
    !indexes.some(
      (row) => row.indexname === 'service_order_grants_lookup_idx',
    ) ||
    !indexes.some(
      (row) => row.indexname === 'service_order_permissions_active_uq',
    )
  )
    throw new Error('Repair authorization index state mismatch');

  const counts = await queryRows(
    qi,
    'SELECT (SELECT count(*) FROM service_order_grant_events) AS events,(SELECT count(*) FROM service_order_operation_grants) AS grants,(SELECT count(*) FROM service_order_permissions) AS permissions',
    { transaction: tx },
  );
  if (
    Number(counts[0].events) ||
    Number(counts[0].grants) ||
    Number(counts[0].permissions)
  )
    throw new Error('Repair refuses non-empty grant/audit tables');

  const functionRow = await queryRows(
    qi,
    "SELECT proname FROM pg_proc WHERE proname='set_service_order_grant_event_hash'",
    { transaction: tx },
  );
  const trigger = await queryRows(
    qi,
    "SELECT tgname FROM pg_trigger WHERE tgrelid='service_order_grant_events'::regclass AND tgname='service_order_grant_event_hash_before_insert'",
    { transaction: tx },
  );
  if (functionRow.length || trigger.length)
    throw new Error('Repair hash function/trigger already exists');
}

module.exports = {
  async up(qi) {
    return qi.sequelize.transaction(async (tx) => {
      await assertRepairState(qi, tx);
      await qi.sequelize.query(
        `CREATE EXTENSION IF NOT EXISTS pgcrypto;
         CREATE OR REPLACE FUNCTION set_service_order_grant_event_hash()
         RETURNS trigger AS $$
         DECLARE prior_hash VARCHAR(64);
         BEGIN
           PERFORM pg_advisory_xact_lock(hashtextextended(NEW.grant_id::text,0));
           SELECT audit_hash INTO prior_hash
           FROM service_order_grant_events
           WHERE grant_id=NEW.grant_id AND id<>NEW.id
           ORDER BY occurred_at DESC,id DESC
           LIMIT 1;
           NEW.audit_previous_hash:=COALESCE(prior_hash,repeat('0',64));
           IF NEW.audit_hash<>repeat('0',64) THEN
             RAISE EXCEPTION 'grant event hash is database-generated';
           END IF;
           NEW.audit_hash:=encode(digest(
             NEW.id::text||':'||NEW.grant_id::text||':'||NEW.actor_user_id::text||':'||
             NEW.target_user_id::text||':'||NEW.sector_id::text||':'||NEW.operation||':'||
             NEW.action||':'||NEW.reason||':'||NEW.occurred_at::text||':'||
             NEW.audit_previous_hash,'sha256'),'hex');
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql;
         CREATE TRIGGER service_order_grant_event_hash_before_insert
           BEFORE INSERT ON service_order_grant_events
           FOR EACH ROW EXECUTE FUNCTION set_service_order_grant_event_hash();`,
        { transaction: tx },
      );
    });
  },
  async down() {
    throw new Error('Forward-only repair: preserve grant audit integrity');
  },
};
