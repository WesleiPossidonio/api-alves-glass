import pg from 'pg'
import dotenv from 'dotenv'
dotenv.config()

/**
 * Configuração exclusiva do executor do baseline canônico.
 * Não depende de .sequelizerc legado nem de configuração legada.
 * Usa storage 'sequelize' com tabela e schema dedicados para isolamento do histórico.
 */
export default {
  dialect: 'postgres',
  dialectModule: pg,
  host: process.env.BASELINE_DB_HOST,
  port: process.env.BASELINE_DB_PORT || 5432,
  username: process.env.BASELINE_DB_USERNAME,
  password: process.env.BASELINE_DB_PASSWORD,
  database: process.env.BASELINE_DB_DATABASE,
  define: {
    timestamps: true,
    underscored: true,
    underscoredAll: true,
  },
  logging: false,
  // Configuração de metadata isolada do baseline
  migrationStorage: 'sequelize',
  migrationStorageTableName: 'SequelizeMetaBaseline',
  migrationStorageTableSchema: 'baseline_meta',
}