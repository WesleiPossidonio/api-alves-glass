'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('material_balances', 'updated_at', {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW,
    })
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('material_balances', 'updated_at')
  },
}