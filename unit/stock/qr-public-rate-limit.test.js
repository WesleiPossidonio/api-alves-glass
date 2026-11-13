import assert from 'node:assert/strict'
import test from 'node:test'
import Database from '../../src/database/index.js'
import QrPublicRateLimitRepository from '../../src/app/repositories/QrPublicRateLimitRepository.js'

test('public QR limiter uses independent persistent table and atomic capped window counter', async () => {
  const originalTransaction = Database.connection.transaction
  const originalQuery = Database.connection.query
  const queries = []
  try {
    Database.connection.transaction = async callback => callback({ id: 'tx' })
    Database.connection.query = async (sql, options) => {
      queries.push({ sql, options })
      if (sql.includes('INSERT INTO qr_public_rate_limits')) return [[{ request_count: 5 }], {}]
      return [[], {}]
    }
    const allowed = await QrPublicRateLimitRepository.consume('a'.repeat(64), new Date('2026-11-12T12:00:00Z'), 60_000, 5)
    assert.equal(allowed, true)
    assert.equal(queries.length, 1)
    assert.match(queries[0].sql, /INSERT INTO qr_public_rate_limits/)
    assert.match(queries[0].sql, /ON CONFLICT\(origin_hash\) DO UPDATE/)
    assert.match(queries[0].sql, /LEAST\(:maxRequests \+ 1/)
    assert.doesNotMatch(queries[0].sql, /pin_attempts/)
    assert.equal(queries[0].options.transaction.id, 'tx')
  } finally {
    Database.connection.transaction = originalTransaction
    Database.connection.query = originalQuery
  }
})

test('QR limiter rejects request six in a persistent origin window', async () => {
  const originalTransaction = Database.connection.transaction
  const originalQuery = Database.connection.query
  try {
    Database.connection.transaction = async callback => callback({})
    Database.connection.query = async sql => sql.includes('INSERT INTO qr_public_rate_limits') ? [[{ request_count: 6 }], {}] : [[], {}]
    assert.equal(await QrPublicRateLimitRepository.consume('b'.repeat(64), new Date(), 60_000, 5), false)
  } finally {
    Database.connection.transaction = originalTransaction
    Database.connection.query = originalQuery
  }
})