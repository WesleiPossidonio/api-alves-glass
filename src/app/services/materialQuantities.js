export const MATERIAL_UNIT_SCALES = Object.freeze({
  un: 0,
  kg: 3,
  g: 3,
  m: 3,
  cm: 3,
  L: 3,
  mL: 3,
  'm²': 3,
})

export function isValidDecimal(value, scale, { allowZero = true } = {}) {
  if (typeof value !== 'string') return false
  const text = value
  if (text.length > 100 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return false
  const decimals = text.split('.')[1]?.length || 0
  if (decimals > scale) return false
  return allowZero || /[1-9]/.test(text)
}

export function normalizeName(value) {
  return typeof value === 'string' ? value.trim() : ''
}