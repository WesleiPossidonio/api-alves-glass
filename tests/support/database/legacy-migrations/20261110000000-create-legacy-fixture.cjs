'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('_legacy_fixture_probe', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        primaryKey: true,
      },
    })
  },
  async down(queryInterface) {
    await queryInterface.dropTable('_legacy_fixture_probe')
  },
}