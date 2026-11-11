import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import jwt from 'jsonwebtoken'
import ClientRepository from '../../../src/app/repositories/ClientRepository.js'
import AuthSessionRepository from '../../../src/app/repositories/AuthSessionRepository.js'
import AuthSessionRefreshTokenRepository from '../../../src/app/repositories/AuthSessionRefreshTokenRepository.js'
import Database from '../../../src/database/index.js'
import { hashPassword } from '../../../src/app/services/passwordHashing.js'
import SessionClientService from '../../../src/app/services/SessionClientService.js'
import SessionGoogleService from '../../../src/app/services/SessionGoogleService.js'

const originals = {
  findByEmail: ClientRepository.findByEmail,
  findByGoogleId: ClientRepository.findByGoogleId,
  createSession: AuthSessionRepository.create,
  createRefresh: AuthSessionRefreshTokenRepository.create,
  transaction: Database.connection.transaction,
}

test('Client ativo autentica por Argon2id e cria sessão exclusivamente de Client', async () => {
  const client = { id: 'client-id', email: 'client@example.test', client_status: 'active', password_hash: await hashPassword('password') }
  client.checkPassword = (password) => import('../../../src/app/services/passwordHashing.js').then(({ validatePassword }) => validatePassword(password, client.password_hash))
  const sessions = []; const refreshes = []
  ClientRepository.findByEmail = async () => client
  AuthSessionRepository.create = async (data, { transaction }) => { assert.equal(transaction, 'tx'); sessions.push(data); return { ...data, id: 'session-id' } }
  AuthSessionRefreshTokenRepository.create = async (data, { transaction }) => { assert.equal(transaction, 'tx'); refreshes.push(data); return data }
  Database.connection.transaction = (callback) => callback('tx')
  try {
    const result = await SessionClientService.loginClient({ email: client.email, password: 'password' })
    assert.equal(sessions[0].actor_type, 'client')
    assert.equal(sessions[0].client_id, client.id)
    assert.equal(sessions[0].user_id, null)
    assert.equal(refreshes[0].token_hash, createHash('sha256').update(result.refreshToken).digest('hex'))
    const claims = jwt.decode(result.accessToken)
    assert.equal(claims.sub, client.id)
    assert.equal(claims.actor_type, 'client')
    assert.equal(claims.role, 'client')
  } finally { restore() }
})

test('Client rejeita senha inválida, conta inativa e Google sub não vinculado', async () => {
  ClientRepository.findByEmail = async () => ({ client_status: 'inactive', checkPassword: async () => true })
  await assert.rejects(SessionClientService.loginClient({ email: 'inactive@example.test', password: 'x' }), /Invalid credentials/)
  ClientRepository.findByEmail = async () => ({ client_status: 'active', checkPassword: async () => false })
  await assert.rejects(SessionClientService.loginClient({ email: 'client@example.test', password: 'wrong' }), /Invalid credentials/)
  ClientRepository.findByGoogleId = async () => null
  await assert.rejects(SessionGoogleService.loginClient({ sub: 'unlinked-sub' }), /Invalid credentials/)
  restore()
})

function restore() {
  ClientRepository.findByEmail = originals.findByEmail
  ClientRepository.findByGoogleId = originals.findByGoogleId
  AuthSessionRepository.create = originals.createSession
  AuthSessionRefreshTokenRepository.create = originals.createRefresh
  Database.connection.transaction = originals.transaction
}

test('close Client session service stubs', restore)