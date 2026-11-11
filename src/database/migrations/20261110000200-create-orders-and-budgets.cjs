'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('order', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      client_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'client', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      order_number: { type: Sequelize.STRING, allowNull: false, unique: true },
      status_description: { type: Sequelize.STRING, allowNull: false },
      status: { type: Sequelize.STRING, allowNull: false },
      total: { type: Sequelize.INTEGER, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
    await queryInterface.createTable('budget', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      client_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'client', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      name_budget: { type: Sequelize.STRING, allowNull: false },
      description_budget: { type: Sequelize.STRING, allowNull: false },
      expiration_date: { type: Sequelize.DATE, allowNull: false },
      total_value: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      pdf_object_name: { type: Sequelize.STRING, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
  },
  async down(queryInterface) {
    await queryInterface.dropTable('budget')
    await queryInterface.dropTable('order')
  },
}