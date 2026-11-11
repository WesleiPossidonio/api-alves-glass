'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('orders_products', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      order_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'order', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      product_name: { type: Sequelize.STRING, allowNull: false },
      quantity: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      unit_price: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
    await queryInterface.createTable('order_address', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      order_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'order', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      cep: Sequelize.STRING,
      rua: Sequelize.STRING,
      number_house: Sequelize.STRING,
      bairro: Sequelize.STRING,
      cidade: Sequelize.STRING,
      uf: Sequelize.STRING,
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
  },
  async down(queryInterface) {
    await queryInterface.dropTable('order_address')
    await queryInterface.dropTable('orders_products')
  },
}