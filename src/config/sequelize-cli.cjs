'use strict'

require('dotenv').config()

const common = {
  dialect: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  logging: false,
  migrationStorage: 'sequelize',
  migrationStorageTableName: 'SequelizeMeta',
}

module.exports = {
  development: { ...common, database: process.env.DB_DATABASE },
  test: { ...common, database: process.env.DB_DATABASE },
  production: { ...common, database: process.env.DB_DATABASE },
}