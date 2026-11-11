import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import jwt from 'jsonwebtoken'
import UserRepository from '../../../src/app/repositories/UserRepository.js'
import AuthSessionRepository from '../../../src/app/repositories/AuthSessionRepository.js'
import AuthSessionRefreshTokenRepository from '../../../src/app/repositories/AuthSessionRefreshTokenRepository.js'
import Database from '../../../src/database/index.js'
import { hashPassword } from '../../../src/app/services/passwordHashing.js'
import SessionUserService from '../../../src/app/services/SessionUserService.js'

const originalFindByEmail = UserRepository.findByEmail
const originalCreateSession = AuthSessionRepository.create
const originalCreateRefresh = AuthSessionRefreshTokenRepository.create
const originalTransaction = Database.connection.transaction
const sessions = []
const refreshRecords = []

test('US1: login User ativo cria sessão e persiste somente SHA-256 do Refresh Token na mesma transação', async () => {
  const user = { id: 'user-uuid', email: 'admin@example.test', role: 'admin', status_users: 'active', password_hash: await hashPassword('correct-password') }
  user.checkPassword = async (password) => (await import('../../../src/app/services/passwordHashing.js')).validatePassword(password, user.password_hash, {
    legacyVerifier: (plain, hash) => import('bcrypt').then(({ default: bcrypt }) => bcrypt.compare(plain, hash)),
  })
  UserRepository.findByEmail = async () => user
  AuthSessionRepository.create = async (data, { transaction }) => {
    assert.equal(transaction, 'test-transaction')
    const row = { id: 'session-uuid', ...data }
    sessions.push(row)
    return row
  }
  AuthSessionRefreshTokenRepository.create = async (data, { transaction }) => {
    assert.equal(transaction, 'test-transaction')
    const row = { id: 'refresh-row-uuid', ...data }
    refreshRecords.push(row)
    return row
  }
  Database.connection.transaction = async (callback) => callback('test-transaction')
  const result = await SessionUserService.loginUser({ email: user.email, password: 'correct-password' })
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].user_id, user.id)
  assert.equal(sessions[0].actor_type, 'user')
  assert.ok(result.refreshToken)
  assert.notEqual(refreshRecords[0].token_hash, result.refreshToken)
  assert.equal(refreshRecords[0].token_hash, createHash('sha256').update(result.refreshToken).digest('hex'))
  assert.equal(Date.parse(result.expiresAt) - Date.parse(sessions[0].created_at), 7 * 24 * 60 * 60 * 1000)
  assert.equal(result.sessionId, sessions[0].id)
  const claims = jwt.decode(result.accessToken)
  assert.equal(claims.sub, user.id)
  assert.equal(claims.sid, sessions[0].id)
  assert.equal(claims.actor_type, 'user')
  assert.equal(claims.exp - claims.iat, 15 * 60)
})

test('US1: login rejeita credencial incorreta e conta inativa sem criar sessão', async () => {
  UserRepository.findByEmail = async () => ({ status_users: 'inactive' })
  await assert.rejects(() => SessionUserService.loginUser({ email: 'inactive@example.test', password: 'x' }), /Invalid credentials/)
  UserRepository.findByEmail = async () => ({ status_users: 'active', password_hash: '$argon2id$invalid', checkPassword: async () => false })
  await assert.rejects(() => SessionUserService.loginUser({ email: 'active@example.test', password: 'wrong' }), /Invalid credentials/)
  assert.equal(sessions.length, 1)
})

test('close Sequelize metadata instance', async () => {
  UserRepository.findByEmail = originalFindByEmail
  AuthSessionRepository.create = originalCreateSession
  AuthSessionRefreshTokenRepository.create = originalCreateRefresh
  Database.connection.transaction = originalTransaction
})