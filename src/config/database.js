import pg from 'pg'
import dotenv from 'dotenv'
dotenv.config()

export default {
  dialect: 'postgres',
  dialectModule: pg,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  define: {
    timestamps: true,
    underscored: true,
    underscoredAll: true,
  },
  logging: false,
}