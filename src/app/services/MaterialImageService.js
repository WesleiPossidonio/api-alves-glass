import Database from '../../database/index.js'
import MaterialRepository from '../repositories/MaterialRepository.js'
import StorageService from './StorageService.js'

// Workflow remains unavailable to HTTP routes until operational MinIO validation and feature gates pass.
export class MaterialImageServiceClient {
  constructor({ database = Database, materials = MaterialRepository, storage = StorageService, intents, cleanupJobs, canAccessMaterial } = {}) {
    this.database = database
    this.materials = materials
    this.storage = storage
    this.intents = intents
    this.cleanupJobs = cleanupJobs
    this.canAccessMaterial = canAccessMaterial
  }

  async replace(actor, materialId, file, { visibility = 'private' } = {}) {
    if (!actor?.id || !['admin', 'user'].includes(actor.role)) return { error: 'forbidden' }
    if (!this.intents || !this.cleanupJobs) return { error: 'storagePersistenceUnavailable' }
    const material = await this.materials.findById(materialId)
    if (!material) return { error: 'notFound' }
    if (typeof this.canAccessMaterial !== 'function' || !await this.canAccessMaterial(actor, material)) return { error: 'notFound' }

    const target = this.storage.prepareImageUpload(file, `materials/${materialId}`, visibility)
    if (target.error) return target
    const intent = await this.database.connection.transaction(transaction => this.intents.create({
      status: 'UPLOADING', bucket: target.bucket, object_key: target.objectName, created_by: actor.id,
      lease_expires_at: new Date(Date.now() + 15 * 60 * 1000),
    }, { transaction }))
    try {
      const uploaded = await this.storage.putPreparedImage(file, target)
      await this.intents.renewLease(intent.id)
      await this.cleanupJobs.withObjectLock({ bucket: target.bucket, objectName: target.objectName }, async transaction => {
        const current = await this.materials.findByIdForUpdate(materialId, transaction)
        if (!current) throw Object.assign(new Error('Material not found'), { code: 'MATERIAL_NOT_FOUND' })
        const previous = current.image_bucket && current.image_object_key
          ? { bucket: current.image_bucket, objectName: current.image_object_key }
          : null
        await current.update({ image_bucket: uploaded.bucket, image_object_key: uploaded.objectName, image_visibility: visibility }, { transaction })
        await this.intents.markCommitted(intent.id, { transaction })
        if (previous) await this.cleanupJobs.enqueue({ bucket: previous.bucket, object_key: previous.objectName }, { transaction })
      })
      return { image: { bucket: uploaded.bucket, objectKey: uploaded.objectName, visibility } }
    } catch (error) {
      await this.intents.markAbandoned(intent.id, 'upload_or_reference_commit_failed').catch(() => {})
      throw error
    }
  }
}

export default new MaterialImageServiceClient()