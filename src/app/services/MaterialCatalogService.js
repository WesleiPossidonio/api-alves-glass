import Database from '../../database/index.js'
import MaterialCategoryRepository from '../repositories/MaterialCategoryRepository.js'
import MaterialRepository from '../repositories/MaterialRepository.js'
import MaterialBalanceRepository from '../repositories/MaterialBalanceRepository.js'
import InventoryEventRepository from '../repositories/InventoryEventRepository.js'
import WarehouseRepository from '../repositories/WarehouseRepository.js'
import UserSectorRepository from '../repositories/UserSectorRepository.js'
import { isValidDecimal, MATERIAL_UNIT_SCALES, normalizeName } from './materialQuantities.js'

const categoryFields = new Set(['name', 'active'])
const materialFields = new Set(['code', 'name', 'description', 'unit_code', 'min_quantity', 'location', 'category_id', 'subcategory_id', 'active'])
const fail = (error) => ({ error })

class MaterialCatalogService {
  async canAccessWarehouse(actor, warehouseId) {
    const warehouse = await WarehouseRepository.findById(warehouseId)
    if (!warehouse) return null
    if (actor.role === 'admin') return warehouse
    const sectorIds = await UserSectorRepository.findSectorIdsByUser(actor.id)
    return sectorIds.includes(warehouse.sector_id) ? warehouse : null
  }

  async listCategories(actor, warehouseId) {
    if (!await this.canAccessWarehouse(actor, warehouseId)) return null
    return MaterialCategoryRepository.findCategories(warehouseId)
  }

  async createCategory(actor, warehouseId, input) {
    const warehouse = await this.canAccessWarehouse(actor, warehouseId)
    if (!warehouse) return fail('notFound')
    const name = normalizeName(input.name)
    if (!name || name.length > 120) return fail('validation')
    try { return await MaterialCategoryRepository.createCategory({ warehouse_id: warehouseId, name }) }
    catch (error) { if (error.name === 'SequelizeUniqueConstraintError' || error.original?.code === '23505' || error.code === '23505') return fail('conflict'); throw error }
  }

  async updateCategory(actor, id, input) {
    const category = await MaterialCategoryRepository.findCategory(id)
    if (!category || !await this.canAccessWarehouse(actor, category.warehouse_id)) return fail('notFound')
    if (!Object.keys(input).length || Object.keys(input).some(key => !categoryFields.has(key))) return fail('validation')
    const changes = { ...input }
    if ('name' in changes) {
      changes.name = normalizeName(changes.name)
      if (!changes.name || changes.name.length > 120) return fail('validation')
    }
    try { await category.update(changes); return category }
    catch (error) { if (error.name === 'SequelizeUniqueConstraintError') return fail('conflict'); throw error }
  }

  async listSubcategories(actor, categoryId) {
    const category = await MaterialCategoryRepository.findCategory(categoryId)
    if (!category || !await this.canAccessWarehouse(actor, category.warehouse_id)) return null
    return MaterialCategoryRepository.findSubcategories(categoryId)
  }

  async createSubcategory(actor, categoryId, input) {
    const category = await MaterialCategoryRepository.findCategory(categoryId)
    if (!category || !await this.canAccessWarehouse(actor, category.warehouse_id)) return fail('notFound')
    const name = normalizeName(input.name)
    if (!name || name.length > 120) return fail('validation')
    try { return await MaterialCategoryRepository.createSubcategory({ category_id: categoryId, warehouse_id: category.warehouse_id, name }) }
    catch (error) { if (error.name === 'SequelizeUniqueConstraintError') return fail('conflict'); throw error }
  }

  async updateSubcategory(actor, id, input) {
    const subcategory = await MaterialCategoryRepository.findSubcategory(id)
    if (!subcategory || !await this.canAccessWarehouse(actor, subcategory.warehouse_id)) return fail('notFound')
    if (!Object.keys(input).length || Object.keys(input).some(key => !categoryFields.has(key))) return fail('validation')
    const changes = { ...input }
    if ('name' in changes) {
      changes.name = normalizeName(changes.name)
      if (!changes.name || changes.name.length > 120) return fail('validation')
    }
    try { await subcategory.update(changes); return subcategory }
    catch (error) { if (error.name === 'SequelizeUniqueConstraintError') return fail('conflict'); throw error }
  }

  async listMaterials(actor, warehouseId) {
    if (!await this.canAccessWarehouse(actor, warehouseId)) return null
    return MaterialRepository.findAllForWarehouse(warehouseId)
  }

  async getMaterial(actor, id) {
    const material = await MaterialRepository.findById(id)
    if (!material || !await this.canAccessWarehouse(actor, material.warehouse_id)) return null
    return material
  }

  async createMaterial(actor, warehouseId, input, { transaction: outerTransaction } = {}) {
    const warehouse = await this.canAccessWarehouse(actor, warehouseId)
    if (!warehouse) return fail('notFound')
    if (Object.keys(input).some(key => !materialFields.has(key) && key !== 'initialQuantity') || !input.code || !input.name || !input.category_id || !input.unit_code || !Object.hasOwn(input, 'initialQuantity')) return fail('validation')
    if (input.code !== input.code.trim() || input.code.length > 64 || !input.name.trim() || input.name.trim().length > 160) return fail('validation')
    const scale = MATERIAL_UNIT_SCALES[input.unit_code]
    if (scale === undefined || !isValidDecimal(input.min_quantity ?? '0', scale) || !isValidDecimal(input.initialQuantity, scale)) return fail('validation')
    const category = await MaterialCategoryRepository.findCategory(input.category_id)
    if (!category || category.warehouse_id !== warehouseId) return fail('notFound')
    if (input.subcategory_id) {
      const subcategory = await MaterialCategoryRepository.findSubcategory(input.subcategory_id)
      if (!subcategory || subcategory.category_id !== category.id || subcategory.warehouse_id !== warehouseId) return fail('validation')
    }
    try {
      const create = async transaction => {
        const { initialQuantity, ...materialInput } = input
        const material = await MaterialRepository.create({ ...materialInput, warehouse_id: warehouseId, name: input.name.trim(), min_quantity: input.min_quantity ?? '0' }, { transaction })
        await MaterialBalanceRepository.create({ material_id: material.id, quantity: initialQuantity }, { transaction })
        await InventoryEventRepository.create({
          material_id: material.id,
          warehouse_id: warehouseId,
          event_type: 'OPENING',
          delta: initialQuantity,
          balance_before: '0',
          balance_after: initialQuantity,
          unit_code_snapshot: material.unit_code,
          reason_code: 'INITIAL_STOCK',
          description: 'Initial quantity recorded during material creation',
          sequence: '1',
          performed_by: actor.id,
          received_by: null,
          command_origin: 'SESSION',
          return_of_event_id: null,
          compensates_event_id: null,
        }, transaction)
        return material
      }
      return outerTransaction ? await create(outerTransaction) : await Database.connection.transaction(create)
    } catch (error) { if (error.name === 'SequelizeUniqueConstraintError' || error.original?.code === '23505' || error.code === '23505') return fail('conflict'); throw error }
  }

  async updateMaterial(actor, id, input) {
    const material = await MaterialRepository.findById(id)
    if (!material || !await this.canAccessWarehouse(actor, material.warehouse_id)) return fail('notFound')
    if (!Object.keys(input).length || Object.keys(input).some(key => !materialFields.has(key) || key === 'code')) return fail('validation')
    const changes = { ...input }
    if ('category_id' in changes || 'subcategory_id' in changes) {
      const categoryId = changes.category_id ?? material.category_id
      const category = await MaterialCategoryRepository.findCategory(categoryId)
      if (!category || category.warehouse_id !== material.warehouse_id) return fail('validation')
      const subcategoryId = Object.hasOwn(changes, 'subcategory_id') ? changes.subcategory_id : material.subcategory_id
      if (subcategoryId) {
        const subcategory = await MaterialCategoryRepository.findSubcategory(subcategoryId)
        if (!subcategory || subcategory.category_id !== category.id) return fail('validation')
      }
    }
    const unit = changes.unit_code ?? material.unit_code
    const scale = MATERIAL_UNIT_SCALES[unit]
    if (scale === undefined || ('min_quantity' in changes && !isValidDecimal(changes.min_quantity, scale))) return fail('validation')
    if ('name' in changes) {
      changes.name = normalizeName(changes.name)
      if (!changes.name || changes.name.length > 160) return fail('validation')
    }
    if ('min_quantity' in changes) changes.min_quantity = String(changes.min_quantity)
    if ('unit_code' in changes && changes.unit_code !== material.unit_code) return fail('validation')
    if (changes.active === false) {
      return Database.connection.transaction(async transaction => {
        const current = await MaterialRepository.findByIdForUpdate(id, transaction)
        if (!current) return fail('notFound')
        const balance = await MaterialBalanceRepository.findByMaterialIdForUpdate(id, transaction)
        if (balance && !/^\+?0+(?:\.0+)?$/.test(String(balance.quantity))) return fail('balanceNotZero')
        await current.update(changes, { transaction })
        return current
      })
    }
    await material.update(changes)
    return material
  }

}

export default new MaterialCatalogService()