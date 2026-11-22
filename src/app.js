import express from 'express'
import routes from './routes.js'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import './database/index.js'
import { randomUUID } from 'node:crypto'

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
    // Scope CORS rejection formatting to Feature005; legacy error behavior is
    // unchanged. CORS runs before session/multipart and otherwise emits HTML500.
    this.app.use(['/budgets', '/client/budgets'], (error, request, response, next) => {
      if (!error) return next()
      return response.status(403).json({ error: { code: 'csrfFailed', message: 'csrfFailed', requestId: randomUUID() } })
    })
    this.app.use(express.json())
    this.app.use(['/budgets', '/client/budgets'], (error, request, response, next) => {
      if (!error) return next()
      const code = error.type === 'entity.too.large' ? 'fileTooLarge' : 'invalidInput'
      return response.status(code === 'fileTooLarge' ? 413 : 400).json({ error: { code, message: code, requestId: randomUUID() } })
    })
    this.app.use(cookieParser())
  }

  routes () {
    this.app.use(routes)
  }

  checkOrigin (origin, callback) {
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost'
    ]

    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true) // Permitir acesso
    } else {
      callback(new Error('Acesso bloqueado por política de CORS'))
    }
  }
}

export default new App().app