export function parseDecimal(value, scale, { signed = false, allowZero = true } = {}) {
  if (typeof value !== 'string' || value.length > 100) return null
  const pattern = signed ? /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/ : /^(?:0|[1-9]\d*)(?:\.\d+)?$/
  if (!pattern.test(value) || (value.split('.')[1]?.length || 0) > scale) return null
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [whole, fraction = ''] = unsigned.split('.')
  const units = BigInt(`${whole}${fraction.padEnd(scale, '0') || ''}`)
  if ((!allowZero && units === 0n) || (negative && units === 0n)) return null
  return { units: negative ? -units : units, scale }
}

export function formatDecimal(value, scale) {
  const units = typeof value === 'bigint' ? value : BigInt(value)
  const negative = units < 0n
  const absolute = negative ? -units : units
  if (scale === 0) return `${negative ? '-' : ''}${absolute}`
  const divisor = 10n ** BigInt(scale)
  const whole = absolute / divisor
  const fraction = String(absolute % divisor).padStart(scale, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

export function addDecimal(left, right) {
  if (left.scale !== right.scale) throw new TypeError('Decimal scales must match')
  return { units: left.units + right.units, scale: left.scale }
}

export function negateDecimal(value) {
  return { units: -value.units, scale: value.scale }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

import { createHash } from 'node:crypto'