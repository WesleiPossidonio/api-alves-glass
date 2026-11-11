'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('product_category', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      name: { type: Sequelize.STRING, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
    await queryInterface.createTable('category', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      name: { type: Sequelize.STRING, allowNull: false },
      category_section_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'product_category', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
    await queryInterface.createTable('Product', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      category_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'category', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      control_level: { type: Sequelize.ENUM('FREE', 'RESTRICTED'), allowNull: false, defaultValue: 'FREE' },
      item_name: { type: Sequelize.STRING, allowNull: false },
      unit: { type: Sequelize.STRING, allowNull: false },
      sector_name: { type: Sequelize.STRING, allowNull: false },
      code: { type: Sequelize.STRING, allowNull: false, unique: true },
      quantity: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      min_quantity: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 8 },
      location: { type: Sequelize.STRING, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
    await queryInterface.createTable('stock_movements', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      product_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'Product', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
      item_name_snapshot: { type: Sequelize.STRING, allowNull: false },
      movement_type: { type: Sequelize.ENUM('IN', 'OUT'), allowNull: false },
      quantity: { type: Sequelize.INTEGER, allowNull: false },
      user_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      withdrawn_by: Sequelize.STRING,
      added_by: Sequelize.STRING,
      authorized_by: Sequelize.STRING,
      note: Sequelize.STRING,
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
  },
  async down(queryInterface) {
    await queryInterface.dropTable('stock_movements')
    await queryInterface.dropTable('Product')
    await queryInterface.dropTable('category')
    await queryInterface.dropTable('product_category')
  },
}