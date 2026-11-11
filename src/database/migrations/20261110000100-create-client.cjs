'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('client', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      name: { type: Sequelize.STRING, allowNull: false, unique: true },
      email: { type: Sequelize.STRING, allowNull: false, unique: true },
      phone: { type: Sequelize.STRING, allowNull: false },
      password_hash: { type: Sequelize.STRING, allowNull: true },
      update_number: { type: Sequelize.STRING, allowNull: true },
      google_id: { type: Sequelize.STRING, allowNull: true, unique: true },
      client_status: { type: Sequelize.ENUM('active', 'inactive', 'blocked'), allowNull: false, defaultValue: 'active' },
      cep: { type: Sequelize.STRING, allowNull: false },
      rua: { type: Sequelize.STRING, allowNull: false },
      number_house: { type: Sequelize.STRING, allowNull: false },
      bairro: { type: Sequelize.STRING, allowNull: false },
      cidade: { type: Sequelize.STRING, allowNull: false },
      uf: { type: Sequelize.STRING, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
  },
  async down(queryInterface) { await queryInterface.dropTable('client') },
}