'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('material_categories', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      warehouse_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'warehouses', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      name: { type: Sequelize.STRING(120), allowNull: false },
      active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
    await queryInterface.sequelize.query('ALTER TABLE material_categories ADD CONSTRAINT material_categories_id_warehouse_uq UNIQUE (id, warehouse_id)')
    await queryInterface.sequelize.query('CREATE UNIQUE INDEX material_categories_normalized_name_uq ON material_categories (warehouse_id, lower(btrim(name)))')

    await queryInterface.createTable('material_subcategories', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      category_id: { type: Sequelize.UUID, allowNull: false },
      warehouse_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'warehouses', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      name: { type: Sequelize.STRING(120), allowNull: false },
      active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
    await queryInterface.addConstraint('material_subcategories', {
      fields: ['category_id', 'warehouse_id'],
      type: 'foreign key',
      name: 'material_subcategories_category_warehouse_fk',
      references: { table: 'material_categories', fields: ['id', 'warehouse_id'] },
      onUpdate: 'RESTRICT', onDelete: 'RESTRICT',
    })
    await queryInterface.sequelize.query('ALTER TABLE material_subcategories ADD CONSTRAINT material_subcategories_id_warehouse_uq UNIQUE (id, warehouse_id)')
    await queryInterface.sequelize.query('CREATE UNIQUE INDEX material_subcategories_normalized_name_uq ON material_subcategories (category_id, lower(btrim(name)))')
    await queryInterface.sequelize.query(`
      CREATE FUNCTION reject_material_taxonomy_delete() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'material categories and subcategories are inactivated, not deleted' USING ERRCODE = '55000';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER material_categories_no_delete BEFORE DELETE ON material_categories
        FOR EACH ROW EXECUTE FUNCTION reject_material_taxonomy_delete();
      CREATE TRIGGER material_subcategories_no_delete BEFORE DELETE ON material_subcategories
        FOR EACH ROW EXECUTE FUNCTION reject_material_taxonomy_delete();
    `)
    await queryInterface.addIndex('material_subcategories', ['warehouse_id'], { name: 'material_subcategories_warehouse_id_idx' })
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS material_subcategories_no_delete ON material_subcategories')
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS material_categories_no_delete ON material_categories')
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS reject_material_taxonomy_delete()')
    await queryInterface.dropTable('material_subcategories')
    await queryInterface.dropTable('material_categories')
  },
}