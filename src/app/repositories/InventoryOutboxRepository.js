import InventoryOutbox from '../models/InventoryOutbox.js'

class InventoryOutboxRepository {
  create(data, transaction) {
    if (!transaction) throw new Error('Inventory Outbox requires the InventoryEvent transaction')
    return InventoryOutbox.create(data, { transaction })
  }
}

export default new InventoryOutboxRepository()