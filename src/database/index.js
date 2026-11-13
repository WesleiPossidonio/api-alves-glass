import Sequelize from 'sequelize'

import configDataBase from '../config/database.js'
import Client from '../app/models/Client.js'
import User from '../app/models/User.js'
import Order from '../app/models/Order.js'
import OrdersProducts from '../app/models/OrdersProducts.js'
import Budget from '../app/models/Budget.js'
import OrderAddress from '../app/models/OrderAddress.js'
import Category from '../app/models/Category.js'
import ProductCategory from '../app/models/ProductCategory.js'
import Product from '../app/models/Product.js'
import StockMovements from '../app/models/StockMovements.js'
import AuthSession from '../app/models/AuthSession.js'
import AuthSessionRefreshToken from '../app/models/AuthSessionRefreshToken.js'
import Sector from '../app/models/Sector.js'
import Warehouse from '../app/models/Warehouse.js'
import UserSector from '../app/models/UserSector.js'
import SectorAuthorizationAudit from '../app/models/SectorAuthorizationAudit.js'
import MaterialCategory from '../app/models/MaterialCategory.js'
import MaterialSubcategory from '../app/models/MaterialSubcategory.js'
import Material from '../app/models/Material.js'
import MaterialBalance from '../app/models/MaterialBalance.js'
import InventoryEvent from '../app/models/InventoryEvent.js'
import InventoryOutbox from '../app/models/InventoryOutbox.js'
import InventoryEventSnapshot from '../app/models/InventoryEventSnapshot.js'
import MovementIdempotency from '../app/models/MovementIdempotency.js'
import PinCredentialAudit from '../app/models/PinCredentialAudit.js'
import PinAttempt from '../app/models/PinAttempt.js'
import QrPublicRateLimit from '../app/models/QrPublicRateLimit.js'
import MinioCleanupJob from '../app/models/MinioCleanupJob.js'
import MinioUploadIntent from '../app/models/MinioUploadIntent.js'

const models = [
  Client,
  User,
  Order,
  OrdersProducts,
  Budget,
  OrderAddress,
  Category,
  ProductCategory,
  Product,
  StockMovements,
  AuthSession,
  AuthSessionRefreshToken,
  Sector,
  Warehouse,
  UserSector,
  SectorAuthorizationAudit,
  MaterialCategory,
  MaterialSubcategory,
  Material,
  MaterialBalance,
  InventoryEvent,
  InventoryOutbox,
  InventoryEventSnapshot,
  MovementIdempotency,
  PinCredentialAudit,
  PinAttempt,
  QrPublicRateLimit,
  MinioCleanupJob,
  MinioUploadIntent,

]

class Database {
  constructor() {
    this.init()
  }

  init () {
    this.connection = new Sequelize(configDataBase)
    models
      .map((model) => model.init(this.connection))
      .map(
        (model) => model.associate && model.associate(this.connection.models)
      )
    this.models = this.connection.models
  }
}

export default new Database()
