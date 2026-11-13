import MaterialCategory from '../models/MaterialCategory.js'
import MaterialSubcategory from '../models/MaterialSubcategory.js'

class MaterialCategoryRepository {
  findCategory(id, options = {}) { return MaterialCategory.findByPk(id, options) }
  findCategories(warehouseId, options = {}) { return MaterialCategory.findAll({ where: { warehouse_id: warehouseId }, order: [['name', 'ASC']], ...options }) }
  createCategory(data, options = {}) { return MaterialCategory.create(data, options) }
  updateCategory(id, data, options = {}) { return MaterialCategory.update(data, { where: { id }, ...options }) }
  findSubcategory(id, options = {}) { return MaterialSubcategory.findByPk(id, options) }
  findSubcategories(categoryId, options = {}) { return MaterialSubcategory.findAll({ where: { category_id: categoryId }, order: [['name', 'ASC']], ...options }) }
  createSubcategory(data, options = {}) { return MaterialSubcategory.create(data, options) }
  updateSubcategory(id, data, options = {}) { return MaterialSubcategory.update(data, { where: { id }, ...options }) }
}

export default new MaterialCategoryRepository()