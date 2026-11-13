'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('sectors', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      code: { type: Sequelize.STRING(32), allowNull: false, unique: true },
      name: { type: Sequelize.STRING(120), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
    await queryInterface.createTable('warehouses', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      sector_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'sectors', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      code: { type: Sequelize.STRING(64), allowNull: false },
      name: { type: Sequelize.STRING(160), allowNull: false },
      status: { type: Sequelize.ENUM('ACTIVE', 'INACTIVE'), allowNull: false, defaultValue: 'ACTIVE' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
    await queryInterface.addIndex('warehouses', ['sector_id'], { name: 'warehouses_sector_id_idx' })
    await queryInterface.sequelize.query(
      'CREATE UNIQUE INDEX warehouses_sector_normalized_name_uq ON warehouses (sector_id, lower(btrim(name)))',
    )
    await queryInterface.addIndex('warehouses', ['sector_id', 'code'], { name: 'warehouses_sector_code_uq', unique: true })
  },

  async down(queryInterface) {
    await queryInterface.dropTable('warehouses')
    await queryInterface.dropTable('sectors')
    await queryInterface.sequelize.query("DROP TYPE IF EXISTS \"enum_warehouses_status\"")
  },
}