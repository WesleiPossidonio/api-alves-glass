import assert from 'node:assert/strict'
import test from 'node:test'
import app from '../../src/app.js'

test('stock report HTTP contract requires persisted session and validates civil-date query', async () => {
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    assert.equal((await fetch(`${base}/reports/stock?from=2026-01-01&to=2026-02-01`)).status, 401)
    assert.equal((await fetch(`${base}/reports/stock/statement?from=2026-01-01&to=2026-02-01`)).status, 401)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})