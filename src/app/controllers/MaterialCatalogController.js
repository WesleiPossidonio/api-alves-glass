import * as Yup from 'yup'
import MaterialCatalogService from '../services/MaterialCatalogService.js'

const categorySchema = Yup.object({ name: Yup.string().trim().min(1).max(120).required() }).noUnknown()
const updateCategorySchema = Yup.object({ name: Yup.string().trim().min(1).max(120), active: Yup.boolean() }).noUnknown().test('non-empty', 'At least one field is required', value => Object.keys(value || {}).length > 0)
const materialSchema = Yup.object({
  code: Yup.string().max(64).required(), name: Yup.string().trim().min(1).max(160).required(),
  description: Yup.string().nullable(), unit_code: Yup.string().required(), min_quantity: Yup.string(),
  initialQuantity: Yup.string().required(),
  location: Yup.string().max(160).nullable(), category_id: Yup.string().uuid().required(),
  subcategory_id: Yup.string().uuid().nullable(),
}).noUnknown()
const updateMaterialSchema = Yup.object({
  name: Yup.string().trim().min(1).max(160), description: Yup.string().nullable(), unit_code: Yup.string(),
  min_quantity: Yup.string(), location: Yup.string().max(160).nullable(), category_id: Yup.string().uuid(),
  subcategory_id: Yup.string().uuid().nullable(), active: Yup.boolean(),
}).noUnknown().test('non-empty', 'At least one field is required', value => Object.keys(value || {}).length > 0)

function actor(request) { return { id: request.userId, role: request.userRole } }
function respondError(response, result) {
  const status = result.error === 'notFound' ? 404 : result.error === 'conflict' ? 409 : result.error === 'balanceNotZero' ? 409 : 400
  return response.status(status).json({ error: result.error })
}
async function validate(schema, body, response) {
  try { return await schema.validate(body, { abortEarly: false, stripUnknown: false }) }
  catch (error) { response.status(400).json({ error: error.errors }); return null }
}

class MaterialCatalogController {
  async categories(request, response) {
    if (request.method === 'GET') {
      const categories = await MaterialCatalogService.listCategories(actor(request), request.params.warehouseId)
      return categories === null ? response.status(404).json({ error: 'Resource not found' }) : response.json({ categories })
    }
    const body = await validate(categorySchema, request.body, response)
    if (!body) return
    const result = await MaterialCatalogService.createCategory(actor(request), request.params.warehouseId, body)
    return result?.error ? respondError(response, result) : response.status(201).json({ category: result })
  }

  async category(request, response) {
    const body = await validate(updateCategorySchema, request.body, response)
    if (!body) return
    const result = await MaterialCatalogService.updateCategory(actor(request), request.params.id, body)
    return result?.error ? respondError(response, result) : response.json({ category: result })
  }

  async subcategories(request, response) {
    if (request.method === 'GET') {
      const subcategories = await MaterialCatalogService.listSubcategories(actor(request), request.params.categoryId)
      return subcategories === null ? response.status(404).json({ error: 'Resource not found' }) : response.json({ subcategories })
    }
    const body = await validate(categorySchema, request.body, response)
    if (!body) return
    const result = await MaterialCatalogService.createSubcategory(actor(request), request.params.categoryId, body)
    return result?.error ? respondError(response, result) : response.status(201).json({ subcategory: result })
  }

  async subcategory(request, response) {
    const body = await validate(updateCategorySchema, request.body, response)
    if (!body) return
    const result = await MaterialCatalogService.updateSubcategory(actor(request), request.params.id, body)
    return result?.error ? respondError(response, result) : response.json({ subcategory: result })
  }

  async materials(request, response) {
    if (request.method === 'GET') {
      const materials = await MaterialCatalogService.listMaterials(actor(request), request.params.warehouseId)
      return materials === null ? response.status(404).json({ error: 'Resource not found' }) : response.json({ materials })
    }
    const body = await validate(materialSchema, request.body, response)
    if (!body) return
    const result = await MaterialCatalogService.createMaterial(actor(request), request.params.warehouseId, body)
    return result?.error ? respondError(response, result) : response.status(201).json({ material: result })
  }

  async material(request, response) {
    if (request.method === 'GET') {
      const material = await MaterialCatalogService.getMaterial(actor(request), request.params.id)
      return material ? response.json({ material }) : response.status(404).json({ error: 'Resource not found' })
    }
    const body = await validate(updateMaterialSchema, request.body, response)
    if (!body) return
    const result = await MaterialCatalogService.updateMaterial(actor(request), request.params.id, body)
    return result?.error ? respondError(response, result) : response.json({ material: result })
  }
}

export default new MaterialCatalogController()