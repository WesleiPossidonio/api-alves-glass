import assert from 'node:assert/strict'
import test from 'node:test'
import Database from '../../../src/database/index.js'
import AuthSessionRepository from '../../../src/app/repositories/AuthSessionRepository.js'
import AuthSessionRefreshTokenRepository from '../../../src/app/repositories/AuthSessionRefreshTokenRepository.js'
import SessionLifecycleService from '../../../src/app/services/SessionLifecycleService.js'
import { hashRefreshToken } from '../../../src/app/services/sessionSecurity.js'
import UserRepository from '../../../src/app/repositories/UserRepository.js'
import authConfig from '../../../src/config/auth.js'


const originals = { transaction: Database.connection.transaction, userFind: UserRepository.findById, sessionFind: AuthSessionRepository.findByIdForUpdate, sessionRevoke: AuthSessionRepository.revoke, touch: AuthSessionRepository.updateLastUsed, tokenFind: AuthSessionRefreshTokenRepository.findByHash, consume: AuthSessionRefreshTokenRepository.consume, create: AuthSessionRefreshTokenRepository.create, revokeTokens: AuthSessionRefreshTokenRepository.revokeActiveForSession }
function restore() { Object.assign(Database.connection, { transaction: originals.transaction }); Object.assign(UserRepository, { findById: originals.userFind }); Object.assign(AuthSessionRepository, { findByIdForUpdate: originals.sessionFind, revoke: originals.sessionRevoke, updateLastUsed: originals.touch }); Object.assign(AuthSessionRefreshTokenRepository, { findByHash: originals.tokenFind, consume: originals.consume, create: originals.create, revokeActiveForSession: originals.revokeTokens }) }
function setup({ consumed = null } = {}) {
  const session = { id: 'sid', user_id: 'uid', client_id: null, actor_type: 'user', expires_at: new Date(Date.now() + 7 * 86400000), revoked_at: null }
  const row = { id: 'rid', session_id: 'sid', token_hash: hashRefreshToken('old-refresh'), consumed_at: consumed, revoked_at: null }
  const tokens = [row]; let committed = false
  Database.connection.transaction = async (fn) => {
    try { const result = await fn('tx'); committed = true; return result }
    catch (error) { session.transactionRolledBack = true; throw error }
  }
  AuthSessionRepository.findByIdForUpdate = async () => session
  UserRepository.findById = async () => ({ role: 'user' })
  AuthSessionRepository.revoke = async (_id, reason) => { session.revoked_at = new Date(); session.revocation_reason = reason; return [1] }
  AuthSessionRepository.updateLastUsed = async () => [1]
  AuthSessionRefreshTokenRepository.findByHash = async (hash) => tokens.find((token) => token.token_hash === hash) ?? null
  AuthSessionRefreshTokenRepository.consume = async (id, at) => { const token = tokens.find((item) => item.id === id); if (!token || token.consumed_at) return [0]; token.consumed_at = at; return [1] }
  AuthSessionRefreshTokenRepository.create = async (data) => { tokens.push(data); return data }
  AuthSessionRefreshTokenRepository.revokeActiveForSession = async (_id, at) => { for (const token of tokens) if (!token.revoked_at) token.revoked_at = at; return [tokens.length] }
  return { session, tokens, committed: () => committed }
}

test('refresh rotates hash and does not extend absolute expiration', async () => {
  if (!authConfig.secret) authConfig.secret = 'test-only-session-signing-secret-not-for-production'
  const state = setup(); const expiry = state.session.expires_at.getTime()
  try {
    const result = await SessionLifecycleService.refresh('old-refresh', 'sid')
    assert.equal(state.tokens[0].consumed_at instanceof Date, true)
    assert.equal(state.tokens.length, 2)
    assert.equal(state.tokens[1].token_hash, hashRefreshToken(result.refreshToken))
    assert.notEqual(state.tokens[1].token_hash, result.refreshToken)
    assert.equal(new Date(result.expiresAt).getTime(), expiry)
    assert.equal(result.sessionId, 'sid')
  } finally { restore() }
})

test('role lookup failure aborts transaction before refresh token is consumed', async () => {
  const state = setup()
  UserRepository.findById = async (_id, options) => { assert.deepEqual(options, { transaction: 'tx' }); throw new Error('database unavailable') }
  try {
    await assert.rejects(SessionLifecycleService.refresh('old-refresh', 'sid'), /database unavailable/)
    assert.equal(state.tokens[0].consumed_at, null)
    assert.equal(state.tokens.length, 1)
    assert.equal(state.committed(), false)
    assert.equal(state.session.transactionRolledBack, true)
  } finally { restore() }
})

test('reused token revokes only its session transactionally', async () => {
  const state = setup({ consumed: new Date(Date.now() - 1000) })
  try {
    await assert.rejects(SessionLifecycleService.refresh('old-refresh', 'sid'), /reuse detected/)
    assert.ok(state.session.revoked_at)
    assert.equal(state.session.revocation_reason, 'refresh_reuse')
    assert.equal(state.committed(), true)
  } finally { restore() }
})

test('logout revokes session and tokens only for supplied session', async () => {
  const state = setup()
  try {
    assert.equal(await SessionLifecycleService.logout('sid'), true)
    assert.ok(state.session.revoked_at)
    assert.equal(state.session.revocation_reason, 'logout')
  } finally { restore() }
})

test('close SessionLifecycleService stubs', restore)