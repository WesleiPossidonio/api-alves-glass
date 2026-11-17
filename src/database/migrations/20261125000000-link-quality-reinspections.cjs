'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const [prerequisites] = await queryInterface.sequelize.query(
        `SELECT EXISTS (
          SELECT 1 FROM "SequelizeMeta"
          WHERE name = '20261124000000-enable-authorized-quality-self-inspection.cjs'
        ) AS ready`,
        { transaction },
      );
      if (!prerequisites[0]?.ready)
        throw new Error('Quality migration 250 requires migration 240');

      // Serialize schema inspection with DDL and writes. Existing history is
      // never repaired here: accept the exact complete state or fail closed.
      await queryInterface.sequelize.query(
        'LOCK TABLE public.service_order_qualities IN SHARE ROW EXCLUSIVE MODE',
        { transaction },
      );
      const [rows] = await queryInterface.sequelize.query(
        `SELECT
          EXISTS (SELECT 1 FROM pg_attribute
            WHERE attrelid = 'public.service_order_qualities'::regclass
              AND attname = 'parent_quality_id' AND NOT attisdropped) AS column_exists,
          EXISTS (SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = 'public.service_order_qualities'::regclass
              AND a.attname = 'parent_quality_id' AND NOT a.attisdropped
              AND a.atttypid = 'uuid'::regtype AND a.atttypmod = -1
              AND NOT a.attnotnull AND NOT a.atthasdef
              AND a.attidentity = '' AND a.attgenerated = '') AS column_matches,
          (SELECT count(*)::int FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid
              AND a.attnum = ANY(c.conkey)
            WHERE c.conrelid = 'public.service_order_qualities'::regclass
              AND a.attname = 'parent_quality_id') AS constraint_count,
          EXISTS (SELECT 1 FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid
              AND a.attname = 'parent_quality_id'
            JOIN pg_attribute target ON target.attrelid = c.confrelid
              AND target.attname = 'id'
            WHERE c.conrelid = 'public.service_order_qualities'::regclass
              AND c.conname = 'service_order_qualities_parent_quality_id_fkey'
              AND c.contype = 'f' AND c.confrelid = c.conrelid
              AND c.conkey = ARRAY[a.attnum] AND c.confkey = ARRAY[target.attnum]
              AND c.confupdtype = 'c' AND c.confdeltype = 'r'
              AND c.confmatchtype = 's' AND c.convalidated
              AND NOT c.condeferrable AND NOT c.condeferred) AS fk_matches,
          to_regclass('public.service_order_qualities_parent_idx') IS NOT NULL AS index_exists,
          EXISTS (SELECT 1 FROM pg_index i
            WHERE i.indexrelid = to_regclass('public.service_order_qualities_parent_idx')
              AND i.indrelid = 'public.service_order_qualities'::regclass
              AND i.indisvalid AND i.indisready AND i.indislive
              AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
              AND i.indnkeyatts = 1 AND i.indnatts = 1
              AND i.indpred IS NULL AND i.indexprs IS NULL
              AND pg_get_indexdef(i.indexrelid) =
                'CREATE INDEX service_order_qualities_parent_idx ON public.service_order_qualities USING btree (parent_quality_id)'
          ) AS index_matches`,
        { transaction },
      );
      const state = rows[0];
      if (
        state.column_exists &&
        state.column_matches &&
        state.constraint_count === 1 &&
        state.fk_matches &&
        state.index_exists &&
        state.index_matches
      )
        return;

      if (
        state.column_exists ||
        state.index_exists ||
        state.constraint_count !== 0
      )
        throw new Error(
          'Quality migration 250 found a partial or divergent parent_quality_id schema; no changes made',
        );

      await queryInterface.addColumn(
        { tableName: 'service_order_qualities', schema: 'public' },
        'parent_quality_id',
        {
          type: Sequelize.UUID,
          allowNull: true,
          references: {
            model: { tableName: 'service_order_qualities', schema: 'public' },
            key: 'id',
          },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        { transaction },
      );
      await queryInterface.addIndex(
        { tableName: 'service_order_qualities', schema: 'public' },
        ['parent_quality_id'],
        { name: 'service_order_qualities_parent_idx', transaction },
      );
    });
  },
  async down() {
    throw new Error(
      'Forward-only quality history migration; preserve quality history',
    );
  },
};
