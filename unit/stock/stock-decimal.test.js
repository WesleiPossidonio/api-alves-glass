import assert from 'node:assert/strict'
import test from 'node:test'
import { addDecimal, formatDecimal, parseDecimal, sha256 } from '../../src/app/services/stockDecimal.js'

test('stock decimal arithmetic remains exact using integer units', () => {
  const left = parseDecimal('0.1', 3)
  const right = parseDecimal('0.2', 3)
  assert.equal(formatDecimal(addDecimal(left, right).units, 3), '0.3')
  assert.equal(parseDecimal('1.0001', 3), null)
  assert.equal(parseDecimal('0', 0, { allowZero: false }), null)
  assert.equal(parseDecimal('1', 0).units, 1n)
  assert.match(sha256('canonical'), /^[0-9a-f]{64}$/)
})

test('IN and OUT use positive request quantities and keep movement delta sign in domain', () => {
  const quantity = parseDecimal('2.125', 3, { allowZero: false })
  assert.equal(formatDecimal(quantity.units, 3), '2.125')
  assert.equal(formatDecimal(-quantity.units, 3), '-2.125')
  assert.equal(parseDecimal('-2.125', 3, { allowZero: false }), null)
  assert.equal(parseDecimal('0', 3, { allowZero: false }), null)
})