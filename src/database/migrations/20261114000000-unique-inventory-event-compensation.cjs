'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addIndex('inventory_events', ['compensates_event_id'], {
      name: 'inventory_events_one_compensation_per_original_uq',
      unique: true,
      where: { compensates_event_id: { [Sequelize.Op.ne]: null } },
    })
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('inventory_events', 'inventory_events_one_compensation_per_original_uq')
  },
}