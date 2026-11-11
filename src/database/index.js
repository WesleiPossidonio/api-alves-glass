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
