import Sequelize from 'sequelize'
import configDataBase from '../config/database.js'
import Client from '../app/models/Client.js'
import User from '../app/models/User.js'
import Order from '../app/models/Order.js'
import ServicesProducts from '../app/models/ServicesProducts.js'

const models = [Client, User, Order, ServicesProducts]

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
  }
}

export default new Database()
