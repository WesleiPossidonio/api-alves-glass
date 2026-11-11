'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('users', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      name: { type: Sequelize.STRING, allowNull: false, unique: true },
      email: { type: Sequelize.STRING, allowNull: false, unique: true },
      password_hash: { type: Sequelize.STRING, allowNull: false },
      role: { type: Sequelize.ENUM('admin', 'user'), allowNull: false, defaultValue: 'user' },
      status_users: { type: Sequelize.STRING, allowNull: false, defaultValue: 'active' },
      update_number: { type: Sequelize.STRING, allowNull: false, defaultValue: '' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
  },
  async down(queryInterface) { await queryInterface.dropTable('users') },
}