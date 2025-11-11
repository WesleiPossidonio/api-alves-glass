import express from 'express'
import routes from './routes.js'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import './database/index.js'

class App {
  constructor() {
    this.app = express()

    this.middlewares()
    this.routes()
  }

  middlewares () {
    this.app.use(
      cors({
        origin: (origin, callback) => this.checkOrigin(origin, callback),
        credentials: true, // Permite o envio de cookies
      })
    )
    this.app.use(express.json())
    this.app.use(cookieParser())
  }

  routes () {
    this.app.use(routes)
  }

  checkOrigin (origin, callback) {
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:5174',
    ]

    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true) // Permitir acesso
    } else {
      callback(new Error('Acesso bloqueado por política de CORS'))
    }
  }
}

export default new App().app