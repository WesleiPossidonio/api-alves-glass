import dotenv from 'dotenv'

dotenv.config()

const integer = (name, value, fallback, { min = 1, max = 2147483647 } = {}) => {
  const parsed = value === undefined || value === '' ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

const requiredUri = (name, raw, protocol) => {
  if (!raw) throw new Error(`${name} is required`)
  let parsed
  try { parsed = new URL(raw) } catch { throw new Error(`${name} must be a valid URI`) }
  if (!protocol.includes(parsed.protocol)) throw new Error(`${name} protocol must be ${protocol.join(' or ')}`)
  return raw
}

export function readCqrsConfig(env = process.env) {
  const mongodbUri = requiredUri('MONGODB_URI', env.MONGODB_URI, ['mongodb:', 'mongodb+srv:'])
  const rabbitmqUrl = requiredUri('RABBITMQ_URL', env.RABBITMQ_URL, ['amqp:', 'amqps:'])
  const databaseName = env.MONGODB_DATABASE || ''
  if (databaseName && !/^[\w.-]+$/.test(databaseName)) throw new Error('MONGODB_DATABASE contains invalid characters')
  return Object.freeze({
    mongodbUri,
    mongodbDatabase: databaseName || undefined,
    mongodbServerSelectionTimeoutMs: integer('MONGODB_SERVER_SELECTION_TIMEOUT_MS', env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 5000, { max: 120000 }),
    rabbitmqUrl,
    rabbitmqHeartbeatSeconds: integer('RABBITMQ_HEARTBEAT_SECONDS', env.RABBITMQ_HEARTBEAT_SECONDS, 30, { max: 3600 }),
    rabbitmqConnectionTimeoutMs: integer('RABBITMQ_CONNECTION_TIMEOUT_MS', env.RABBITMQ_CONNECTION_TIMEOUT_MS, 5000, { max: 120000 }),
  })
}

export function createCqrsConnections({ config: suppliedConfig, mongoClientFactory, rabbitConnect } = {}) {
  let mongoClientPromise
  let rabbitConnectionPromise
  const getConfig = () => suppliedConfig ?? readCqrsConfig()

  return {
    async getMongoClient() {
      if (!mongoClientPromise) {
        const config = getConfig()
        const factory = mongoClientFactory ?? (await import('mongodb')).MongoClient
        const client = new factory(config.mongodbUri, { serverSelectionTimeoutMS: config.mongodbServerSelectionTimeoutMs })
        mongoClientPromise = client.connect().then(() => client).catch(error => { mongoClientPromise = undefined; throw error })
      }
      return mongoClientPromise
    },
    async getMongoDatabase() {
      const config = getConfig()
      const client = await this.getMongoClient()
      return config.mongodbDatabase ? client.db(config.mongodbDatabase) : client.db()
    },
    async getRabbitConnection() {
      if (!rabbitConnectionPromise) {
        const config = getConfig()
        const connect = rabbitConnect ?? (await import('amqplib')).connect
        rabbitConnectionPromise = connect(config.rabbitmqUrl, {
          heartbeat: config.rabbitmqHeartbeatSeconds,
          timeout: config.rabbitmqConnectionTimeoutMs,
        }).catch(error => { rabbitConnectionPromise = undefined; throw error })
      }
      return rabbitConnectionPromise
    },
    async close() {
      const [mongo, rabbit] = await Promise.allSettled([mongoClientPromise, rabbitConnectionPromise])
      mongoClientPromise = undefined
      rabbitConnectionPromise = undefined
      await Promise.allSettled([
        mongo.status === 'fulfilled' && mongo.value ? mongo.value.close() : undefined,
        rabbit.status === 'fulfilled' && rabbit.value ? rabbit.value.close() : undefined,
      ])
    },
  }
}

export const cqrsConnections = createCqrsConnections()