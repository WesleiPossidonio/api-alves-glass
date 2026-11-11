import assert from 'node:assert/strict'
import test from 'node:test'
import { createAuthRateLimit } from '../../../src/app/meddleawares/authRateLimit.js'

function response() { return { code: 200, headers: {}, status(code) { this.code = code; return this }, json(body) { this.body = body; return this }, set(k, v) { this.headers[k] = v; return this } } }

test('in-memory login limiter returns 429 after configured attempts and resets after window', () => {
  let time = 100; const limiter = createAuthRateLimit({ windowMs: 1000, max: 2, now: () => time }); const request = { path: '/session/user', ip: '127.0.0.1' }
  let count = 0
  for (let i = 0; i < 2; i++) { const r = response(); limiter(request, r, () => count++); assert.equal(r.code, 200) }
  const limited = response(); limiter(request, limited, () => count++)
  assert.equal(limited.code, 429); assert.equal(count, 2)
  assert.equal(limited.headers['Retry-After'], '1')
  time += 1000
  const reset = response(); limiter(request, reset, () => count++)
  assert.equal(reset.code, 200); assert.equal(count, 3)
})