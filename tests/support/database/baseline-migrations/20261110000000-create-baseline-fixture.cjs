'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('_baseline_fixture_probe', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        primaryKey: true,
      },
    })
  },
  async down(queryInterface) {
    await queryInterface.dropTable('_baseline_fixture_probe')
  },
}