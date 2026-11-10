'use strict'

const BASELINE_METADATA_CONFIG = Object.freeze({
  migrationStorage: 'sequelize',
  migrationStorageTableName: 'SequelizeMetaBaseline',
  migrationStorageTableSchema: 'baseline_meta',
})

function createBaselineProfile() {
  return Object.freeze({
    dialect: 'postgres',
    host: process.env.BASELINE_DB_HOST,
    port: process.env.BASELINE_DB_PORT,
    username: process.env.BASELINE_DB_USERNAME,
    password: process.env.BASELINE_DB_PASSWORD,
    database: process.env.BASELINE_DB_DATABASE,
    logging: false,
    ...BASELINE_METADATA_CONFIG,
  })
}

/**
 * Configuração passiva e exclusiva do baseline canônico para sequelize-cli.
 * As identidades e credenciais são fornecidas apenas pelo ambiente já validado pelos gates canônicos;
 * este módulo não carrega dotenv, não abre conexão e não declara fallback para destino legado.
 */
module.exports = Object.freeze({
  'development-rebuild': createBaselineProfile(),
  test: createBaselineProfile(),
})