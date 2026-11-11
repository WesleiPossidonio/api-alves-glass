import assert from 'node:assert/strict'
import { Sequelize } from 'sequelize'
import test from 'node:test'
import AuthSession from '../../../src/app/models/AuthSession.js'
import AuthSessionRefreshToken from '../../../src/app/models/AuthSessionRefreshToken.js'

test('session models register explicit table and column contracts', async () => {
  const sequelize = new Sequelize('postgres://unused:unused@127.0.0.1:1/unused', { logging: false })
  AuthSession.init(sequelize)
  AuthSessionRefreshToken.init(sequelize)

  assert.equal(AuthSession.getTableName(), 'auth_sessions')
  assert.equal(AuthSession.rawAttributes.actor_type.allowNull, false)
  assert.equal(AuthSessionRefreshToken.getTableName(), 'auth_session_refresh_tokens')
  assert.equal(AuthSessionRefreshToken.rawAttributes.token_hash.type.options.length, 64)
  assert.equal(AuthSessionRefreshToken.rawAttributes.session_id.allowNull, false)

  await sequelize.close()
})