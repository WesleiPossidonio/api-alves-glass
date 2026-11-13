'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('materials', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      warehouse_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'warehouses', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      category_id: { type: Sequelize.UUID, allowNull: false },
      subcategory_id: { type: Sequelize.UUID, allowNull: true },
      code: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      name: { type: Sequelize.STRING(160), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      unit_code: { type: Sequelize.STRING(8), allowNull: false },
      min_quantity: { type: Sequelize.NUMERIC, allowNull: false, defaultValue: 0 },
      location: { type: Sequelize.STRING(160), allowNull: true },
      active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    })
    await queryInterface.addConstraint('materials', {
      fields: ['category_id', 'warehouse_id'],
      type: 'foreign key',
      name: 'materials_category_warehouse_fk',
      references: { table: 'material_categories', fields: ['id', 'warehouse_id'] },
      onUpdate: 'RESTRICT', onDelete: 'RESTRICT',
    })
    await queryInterface.sequelize.query(`
      ALTER TABLE materials ADD CONSTRAINT materials_subcategory_warehouse_fk
      FOREIGN KEY (subcategory_id, warehouse_id)
      REFERENCES material_subcategories (id, warehouse_id)
      MATCH SIMPLE ON UPDATE RESTRICT ON DELETE RESTRICT;
    `)
    await queryInterface.sequelize.query(`
      ALTER TABLE materials ADD CONSTRAINT materials_unit_code_ck
        CHECK (unit_code IN ('un','kg','g','m','cm','L','mL','m²'));
      ALTER TABLE materials ADD CONSTRAINT materials_min_quantity_ck
        CHECK (min_quantity >= 0);
      ALTER TABLE materials ADD CONSTRAINT materials_min_quantity_scale_ck
        CHECK ((unit_code = 'un' AND min_quantity = trunc(min_quantity)) OR
               (unit_code <> 'un' AND min_quantity = trunc(min_quantity, 3)));
    `)
    await queryInterface.addIndex('materials', ['warehouse_id'], { name: 'materials_warehouse_id_idx' })
    await queryInterface.addIndex('materials', ['category_id'], { name: 'materials_category_id_idx' })

    await queryInterface.createTable('material_balances', {
      material_id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, references: { model: 'materials', key: 'id' }, onUpdate: 'RESTRICT', onDelete: 'RESTRICT' },
      quantity: { type: Sequelize.NUMERIC, allowNull: false, defaultValue: 0 },
    })
    await queryInterface.sequelize.query(`
      ALTER TABLE material_balances ADD CONSTRAINT material_balances_quantity_ck CHECK (quantity >= 0);
      CREATE FUNCTION validate_material_balance_scale() RETURNS trigger AS $$
      DECLARE unit_scale INTEGER;
      BEGIN
        SELECT CASE WHEN unit_code = 'un' THEN 0 ELSE 3 END INTO unit_scale
        FROM materials WHERE id = NEW.material_id;
        IF unit_scale IS NULL OR NEW.quantity <> trunc(NEW.quantity, unit_scale) THEN
          RAISE EXCEPTION 'material balance exceeds unit scale' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER material_balances_unit_scale
      BEFORE INSERT OR UPDATE OF quantity, material_id ON material_balances
      FOR EACH ROW EXECUTE FUNCTION validate_material_balance_scale();
    `)
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS material_balances_unit_scale ON material_balances')
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS validate_material_balance_scale()')
    await queryInterface.dropTable('material_balances')
    await queryInterface.dropTable('materials')
  },
}