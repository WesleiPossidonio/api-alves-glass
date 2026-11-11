import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Sequelize } from 'sequelize'
import Database from '../../src/database/index.js'
import User from '../../src/app/models/User.js'
import AuthSession from '../../src/app/models/AuthSession.js'
import AuthSessionRefreshToken from '../../src/app/models/AuthSessionRefreshToken.js'
import SessionLifecycleService from '../../src/app/services/SessionLifecycleService.js'
import { hashRefreshToken } from '../../src/app/services/sessionSecurity.js'

test('PostgreSQL integration: concurrent refresh, reuse revocation and session isolation', { skip: process.env.RUN_POSTGRES_AUTH_INTEGRATION !== '1' }, async () => {
  const suffix = randomUUID()
  const user = await User.create({ name: `Lifecycle integration ${suffix}`, email: `lifecycle-${suffix}@example.test`, password: `test-${suffix}`, role: 'user' })
  const isolationUser = await User.create({ name: `Lifecycle isolation ${suffix}`, email: `isolation-${suffix}@example.test`, password: `test-${suffix}`, role: 'user' })
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  const session = await AuthSession.create({ id: randomUUID(), user_id: user.id, client_id: null, actor_type: 'user', created_at: new Date(), expires_at: expiresAt, last_used_at: new Date() })
  const isolatedSession = await AuthSession.create({ id: randomUUID(), user_id: isolationUser.id, client_id: null, actor_type: 'user', created_at: new Date(), expires_at: expiresAt, last_used_at: new Date() })
  const oldToken = `old-${suffix}`
  await AuthSessionRefreshToken.create({ id: randomUUID(), session_id: session.id, token_hash: hashRefreshToken(oldToken), created_at: new Date() })
  await AuthSessionRefreshToken.create({ id: randomUUID(), session_id: isolatedSession.id, token_hash: hashRefreshToken(`isolated-${suffix}`), created_at: new Date() })
  try {
    const outcomes = await Promise.allSettled([
      SessionLifecycleService.refresh(oldToken, session.id),
      SessionLifecycleService.refresh(oldToken, session.id),
    ])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    const updatedSession = await AuthSession.findByPk(session.id)
    const isolated = await AuthSession.findByPk(isolatedSession.id)
    assert.ok(updatedSession.revoked_at)
    assert.equal(updatedSession.revocation_reason, 'refresh_reuse')
    assert.equal(isolated.revoked_at, null)
    const rows = await AuthSessionRefreshToken.findAll({ where: { session_id: session.id } })
    assert.ok(rows.every((row) => row.token_hash.length === 64))
    assert.equal(rows.some((row) => row.token_hash === oldToken), false)
    assert.equal(new Date(updatedSession.expires_at).getTime(), expiresAt.getTime())
  } finally {
    await AuthSessionRefreshToken.destroy({ where: { session_id: [session.id, isolatedSession.id] } })
    await AuthSession.destroy({ where: { id: [session.id, isolatedSession.id] } })
    await user.destroy()
    await isolationUser.destroy()
    await Database.connection.close()
  }
})