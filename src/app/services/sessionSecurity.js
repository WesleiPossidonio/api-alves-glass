import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import authConfig from '../../config/auth.js'

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const hashRefreshToken = (token) => createHash('sha256').update(token).digest('hex')
export const csrfTokenForSession = (sessionId) => createHmac('sha256', authConfig.secret).update(`csrf:${sessionId}`).digest('base64url')

export function verifyCsrfToken(sessionId, token) {
  if (typeof token !== 'string') return false
  const expected = Buffer.from(csrfTokenForSession(sessionId))
  const actual = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function isAllowedOrigin(origin) {
  const configured = (process.env.AUTH_ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://localhost')
    .split(',').map((value) => value.trim()).filter(Boolean)
  if (!origin) return process.env.NODE_ENV !== 'production' && configured.includes('http://localhost')
  return configured.includes(origin)
}

export function csrfCookieOptions(maxAge) {
  return { httpOnly: false, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge }
}