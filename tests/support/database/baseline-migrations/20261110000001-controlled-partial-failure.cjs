'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('_baseline_partial_fixture_probe', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        primaryKey: true,
      },
    })

    throw new Error('controlled baseline fixture failure after schema change')
  },
  async down(queryInterface) {
    await queryInterface.dropTable('_baseline_partial_fixture_probe')
  },
}