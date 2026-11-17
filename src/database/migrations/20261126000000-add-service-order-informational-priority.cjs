'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT 1 FROM "SequelizeMeta"
         WHERE name = '20261125000000-link-quality-reinspections.cjs'`,
        { transaction },
      );
      if (rows.length !== 1)
        throw new Error(
          'Informational priority requires quality migration 250',
        );
      const table = { tableName: 'service_orders', schema: 'public' };
      await queryInterface.addColumn(
        table,
        'is_priority',
        {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        table,
        'priority_changed_by',
        {
          type: Sequelize.UUID,
          allowNull: true,
          references: {
            model: { tableName: 'users', schema: 'public' },
            key: 'id',
          },
          onDelete: 'RESTRICT',
          onUpdate: 'RESTRICT',
        },
        { transaction },
      );
      await queryInterface.addColumn(
        table,
        'priority_changed_at',
        {
          type: Sequelize.DATE,
          allowNull: true,
        },
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE public.service_orders
         ADD CONSTRAINT service_orders_priority_metadata_ck CHECK (
           (priority_changed_by IS NULL) = (priority_changed_at IS NULL)
           AND (NOT is_priority OR priority_changed_by IS NOT NULL)
         )`,
        { transaction },
      );
    });
  },
  async down() {
    throw new Error(
      'Forward-only informational priority migration; preserve history',
    );
  },
};
