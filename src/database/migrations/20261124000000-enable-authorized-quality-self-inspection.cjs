'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const [columns] = await queryInterface.sequelize.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema=current_schema() AND table_name='service_order_qualities'
         ORDER BY ordinal_position`,
        { transaction },
      );
      const expected = [
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
      ];
      if (
        columns.map(({ column_name }) => column_name).join('|') !==
        expected.join('|')
      )
        throw new Error(
          'Refusing quality migration: unexpected service_order_qualities schema',
        );
      const [rows] = await queryInterface.sequelize.query(
        `SELECT count(*)::int AS historical_rows FROM service_order_qualities`,
        { transaction },
      );
      if (!Number.isInteger(rows[0]?.historical_rows))
        throw new Error('Unable to verify historical quality rows');
      await queryInterface.sequelize.query(
        `ALTER TABLE service_order_qualities DROP CONSTRAINT IF EXISTS service_order_qualities_inspector_ck;
         CREATE INDEX IF NOT EXISTS service_order_qualities_pending_fifo_idx
         ON service_order_qualities (created_at, id) WHERE status IN ('OPEN','REWORK');`,
        { transaction },
      );
    });
  },
  async down() {
    throw new Error(
      'Forward-only quality authorization migration; preserve quality history',
    );
  },
};
