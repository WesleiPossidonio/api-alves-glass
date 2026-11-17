'use strict';

const SCHEMA_NAME = 'public';
const TABLE_NAME = 'service_orders';
const INDEX_NAME = 'service_orders_fifo_idx';
const UNIQUE_CONSTRAINT = 'service_orders_sector_external_number_ckey';

const ORIGINAL_INDEX = Object.freeze([
  ['sector_id', 'ASC', 'uuid_ops'],
  ['administrative_state', 'ASC', 'text_ops'],
  ['queue_entered_at', 'ASC', 'timestamptz_ops'],
  ['external_number::numeric', 'ASC', 'numeric_ops'],
  ['id', 'ASC', 'uuid_ops'],
]);

const TEXT_FIFO_INDEX = Object.freeze([
  ['sector_id', 'ASC', 'uuid_ops'],
  ['administrative_state', 'ASC', 'text_ops'],
  ['queue_entered_at', 'ASC', 'timestamptz_ops'],
  ['id', 'ASC', 'uuid_ops'],
]);

async function queryRows(queryInterface, sql, options = {}) {
  const result = await queryInterface.sequelize.query(sql, options);
  return Array.isArray(result?.[0]) ? result[0] : result;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (
    typeof value !== 'string' ||
    !value.startsWith('{') ||
    !value.endsWith('}')
  )
    return null;
  const content = value.slice(1, -1);
  if (!content) return [];
  const values = content
    .split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/)
    .map((part) =>
      part
        .replace(/^"|"$/g, '')
        .replaceAll('\\"', '"')
        .replaceAll('\\\\', '\\'),
    );
  return values.map((value) =>
    value === 'NULL' || value === 'null' ? null : value,
  );
}

function normalizeExpression(expression) {
  return expression
    .replaceAll('"', '')
    .replace(/\s+/g, '')
    .replace(/^\((.*)\)$/, '$1')
    .toLowerCase();
}

async function assertUniqueConstraint(queryInterface, transaction) {
  const rows = await queryRows(
    queryInterface,
    `SELECT c.contype, c.convalidated, i.indisvalid, i.indisready,
            array_agg(a.attname ORDER BY key.ordinality) AS columns
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     JOIN pg_index i ON i.indexrelid = c.conindid
     JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
       ON key.ordinality <= i.indnkeyatts
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key.attnum
     WHERE n.nspname = :schemaName
       AND t.relname = :tableName
       AND c.conname = :constraintName
     GROUP BY c.oid, i.indexrelid`,
    {
      replacements: {
        schemaName: SCHEMA_NAME,
        tableName: TABLE_NAME,
        constraintName: UNIQUE_CONSTRAINT,
      },
      transaction,
    },
  );
  if (
    rows.length !== 1 ||
    rows[0].contype !== 'u' ||
    rows[0].convalidated !== true ||
    rows[0].indisvalid !== true ||
    rows[0].indisready !== true ||
    normalizeArray(rows[0].columns)?.join(',') !== 'sector_id,external_number'
  )
    throw new Error(
      `Unexpected or missing ${UNIQUE_CONSTRAINT} constraint; refusing FIFO index change`,
    );
}

async function assertIndex(queryInterface, transaction, expectedKeys) {
  const rows = await queryRows(
    queryInterface,
    `SELECT ns.nspname AS schema_name, tbl.relname AS table_name,
            idx.relname AS index_name, am.amname AS access_method,
            i.indisunique AS is_unique, i.indisprimary AS is_primary,
            i.indisvalid AS is_valid, i.indisready AS is_ready,
            i.indislive AS is_live, i.indnatts AS attribute_count,
            i.indnkeyatts AS key_count,
            i.indpred IS NULL AS has_no_predicate,
            i.indexprs IS NULL AS has_no_expressions,
            array_agg(pg_get_indexdef(i.indexrelid, key.ordinality::integer, true)
                      ORDER BY key.ordinality) AS keys,
            array_agg(CASE WHEN (i.indoption[key.ordinality - 1] & 1) = 1
                           THEN 'DESC' ELSE 'ASC' END
                      ORDER BY key.ordinality) AS directions,
            array_agg(coll.collname ORDER BY key.ordinality) AS collations,
            array_agg(opc.opcname ORDER BY key.ordinality) AS operator_classes
     FROM pg_class idx
     JOIN pg_namespace ns ON ns.oid = idx.relnamespace
     JOIN pg_index i ON i.indexrelid = idx.oid
     JOIN pg_class tbl ON tbl.oid = i.indrelid
     JOIN pg_am am ON am.oid = idx.relam
     JOIN LATERAL generate_series(1, i.indnatts) AS key(ordinality) ON true
     LEFT JOIN LATERAL unnest(i.indcollation::oid[]) WITH ORDINALITY AS coll_oid(oid, ordinality)
       ON coll_oid.ordinality = key.ordinality
     LEFT JOIN pg_collation coll ON coll.oid = coll_oid.oid
     LEFT JOIN LATERAL unnest(i.indclass::oid[]) WITH ORDINALITY AS opc_oid(oid, ordinality)
       ON opc_oid.ordinality = key.ordinality
     LEFT JOIN pg_opclass opc ON opc.oid = opc_oid.oid
     WHERE ns.nspname = :schemaName AND tbl.relname = :tableName
       AND idx.relname = :indexName
     GROUP BY ns.nspname, tbl.relname, idx.relname, am.amname,
              i.indisunique, i.indisprimary, i.indisvalid, i.indisready,
              i.indislive, i.indnatts, i.indnkeyatts, i.indpred, i.indexprs,
              i.indexrelid`,
    {
      replacements: {
        schemaName: SCHEMA_NAME,
        tableName: TABLE_NAME,
        indexName: INDEX_NAME,
      },
      transaction,
    },
  );

  const row = rows[0];
  const keyNames = normalizeArray(row?.keys)?.map(normalizeExpression);
  const expectedNames = expectedKeys.map(([expression]) =>
    normalizeExpression(expression),
  );
  const expectsExpressions = expectedKeys.some(([expression]) =>
    expression.includes('::'),
  );
  if (
    rows.length !== 1 ||
    row.schema_name !== SCHEMA_NAME ||
    row.table_name !== TABLE_NAME ||
    row.index_name !== INDEX_NAME ||
    row.access_method !== 'btree' ||
    row.is_unique !== false ||
    row.is_primary !== false ||
    row.is_valid !== true ||
    row.is_ready !== true ||
    row.is_live !== true ||
    Number(row.attribute_count) !== expectedKeys.length ||
    Number(row.key_count) !== expectedKeys.length ||
    row.has_no_predicate !== true ||
    row.has_no_expressions !== !expectsExpressions ||
    keyNames?.join('|') !== expectedNames.join('|') ||
    normalizeArray(row.directions)?.join('|') !==
      expectedKeys.map(([, direction]) => direction).join('|') ||
    normalizeArray(row.collations)?.some((collation, index) =>
      expectedKeys[index][2] === 'text_ops'
        ? collation !== 'default'
        : collation !== null && collation !== '',
    ) ||
    normalizeArray(row.operator_classes)?.join('|') !==
      expectedKeys.map(([, , operatorClass]) => operatorClass).join('|')
  )
    throw new Error(`Unexpected ${INDEX_NAME} definition; refusing change`);
}

async function lockAndAssertState(queryInterface, transaction, expectedKeys) {
  await queryInterface.sequelize.query(
    `LOCK TABLE "${SCHEMA_NAME}"."${TABLE_NAME}" IN ACCESS EXCLUSIVE MODE`,
    { transaction },
  );
  await assertUniqueConstraint(queryInterface, transaction);
  await assertIndex(queryInterface, transaction, expectedKeys);
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await lockAndAssertState(queryInterface, transaction, ORIGINAL_INDEX);
      await queryInterface.sequelize.query(
        `DROP INDEX "${SCHEMA_NAME}"."${INDEX_NAME}"`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX "${INDEX_NAME}"
         ON "${SCHEMA_NAME}"."${TABLE_NAME}" USING btree (
           sector_id ASC,
           administrative_state ASC,
           queue_entered_at ASC,
           id ASC
         )`,
        { transaction },
      );
      await assertUniqueConstraint(queryInterface, transaction);
      await assertIndex(queryInterface, transaction, TEXT_FIFO_INDEX);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await lockAndAssertState(queryInterface, transaction, TEXT_FIFO_INDEX);
      const nonNumericNumbers = await queryRows(
        queryInterface,
        `SELECT 1 FROM "${SCHEMA_NAME}"."${TABLE_NAME}"
         WHERE external_number !~ '^[0-9]+$' LIMIT 1`,
        { transaction },
      );
      if (nonNumericNumbers.length > 0)
        throw new Error(
          'Cannot restore numeric FIFO index while textual external numbers exist',
        );

      await queryInterface.sequelize.query(
        `DROP INDEX "${SCHEMA_NAME}"."${INDEX_NAME}"`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX "${INDEX_NAME}"
         ON "${SCHEMA_NAME}"."${TABLE_NAME}" USING btree (
           sector_id ASC,
           administrative_state ASC,
           queue_entered_at ASC,
           ((external_number)::numeric) ASC,
           id ASC
         )`,
        { transaction },
      );
      await assertUniqueConstraint(queryInterface, transaction);
      await assertIndex(queryInterface, transaction, ORIGINAL_INDEX);
    });
  },
};
