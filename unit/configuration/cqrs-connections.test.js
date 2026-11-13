import assert from 'node:assert/strict'
import test from 'node:test'
import { createCqrsConnections, readCqrsConfig } from '../../src/config/cqrs.js'

const validEnv = {
  MONGODB_URI: 'mongodb://user:secret@localhost:27027/db?authSource=admin',
  MONGODB_DATABASE: 'cqrs_test',
  RABBITMQ_URL: 'amqp://user:secret@localhost:5677',
}

test('CQRS configuration validates protocols, database name, and bounded numeric options', () => {
  const config = readCqrsConfig(validEnv)
  assert.equal(config.mongodbDatabase, 'cqrs_test')
  assert.equal(config.rabbitmqHeartbeatSeconds, 30)
  assert.throws(() => readCqrsConfig({ ...validEnv, MONGODB_URI: '' }), /MONGODB_URI is required/)
  assert.throws(() => readCqrsConfig({ ...validEnv, RABBITMQ_URL: 'http://localhost' }), /protocol/)
  assert.throws(() => readCqrsConfig({ ...validEnv, MONGODB_DATABASE: 'bad/name' }), /invalid characters/)
  assert.throws(() => readCqrsConfig({ ...validEnv, RABBITMQ_HEARTBEAT_SECONDS: '0' }), /integer/)
})

test('connections are lazy, reused, recover after connect failure, and close cleanly', async () => {
  const config = readCqrsConfig(validEnv)
  let mongoCreates = 0
  let mongoConnects = 0
  let mongoCloses = 0
  let rabbitConnects = 0
  let rabbitCloses = 0
  let failRabbitOnce = true
  class FakeMongoClient {
    constructor(uri, options) { assert.equal(uri, config.mongodbUri); assert.equal(options.serverSelectionTimeoutMS, 5000); mongoCreates++ }
    async connect() { mongoConnects++; return this }
    db(name) { return { name } }
    async close() { mongoCloses++ }
  }
  const connections = createCqrsConnections({
    config,
    mongoClientFactory: FakeMongoClient,
    rabbitConnect: async (url, options) => {
      assert.equal(url, config.rabbitmqUrl)
      assert.equal(options.heartbeat, 30)
      rabbitConnects++
      if (failRabbitOnce) { failRabbitOnce = false; throw new Error('isolated broker unavailable') }
      return { async close() { rabbitCloses++ } }
    },
  })

  assert.equal(mongoCreates, 0)
  assert.equal((await connections.getMongoDatabase()).name, 'cqrs_test')
  await Promise.all([connections.getMongoClient(), connections.getMongoClient()])
  assert.equal(mongoCreates, 1)
  assert.equal(mongoConnects, 1)
  await assert.rejects(connections.getRabbitConnection(), /isolated broker unavailable/)
  const [rabbitA, rabbitB] = await Promise.all([connections.getRabbitConnection(), connections.getRabbitConnection()])
  assert.equal(rabbitA, rabbitB)
  assert.equal(rabbitConnects, 2)
  await connections.close()
  assert.equal(mongoCloses, 1)
  assert.equal(rabbitCloses, 1)
})