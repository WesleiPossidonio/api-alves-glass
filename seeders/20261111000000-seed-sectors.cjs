'use strict'

const sectors = [
  { code: 'VIDRACARIA', name: 'Vidraçaria' },
  { code: 'MARCENARIA', name: 'Marcenaria' },
]

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      for (const sector of sectors) {
        await queryInterface.sequelize.query(
          `INSERT INTO sectors (id, code, name, created_at, updated_at)
           VALUES (gen_random_uuid(), :code, :name, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (code) DO NOTHING`,
          { replacements: sector, transaction, type: Sequelize.QueryTypes.INSERT },
        )
      }
    })
  },

  async down() {
    // Seeds can be referenced by grants, warehouses and history; rollback intentionally preserves them.
  },
}