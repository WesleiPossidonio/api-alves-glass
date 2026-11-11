const buckets = new Map()

export function createAuthRateLimit({ windowMs = 15 * 60 * 1000, max = 10, now = Date.now } = {}) {
  return (request, response, next) => {
    const key = `${request.path}:${request.ip || request.socket?.remoteAddress || 'unknown'}`
    const current = now()
    let bucket = buckets.get(key)
    if (!bucket || current - bucket.startedAt >= windowMs) {
      if (buckets.size > 5000) {
        for (const [existingKey, existingBucket] of buckets) {
          if (current - existingBucket.startedAt >= windowMs) buckets.delete(existingKey)
        }
      }
      bucket = { startedAt: current, count: 0 }
      buckets.set(key, bucket)
    }
    bucket.count += 1
    response.set?.('RateLimit-Limit', String(max))
    response.set?.('RateLimit-Remaining', String(Math.max(0, max - bucket.count)))
    if (bucket.count > max) {
      response.set?.('Retry-After', String(Math.max(1, Math.ceil((bucket.startedAt + windowMs - current) / 1000))))
      return response.status(429).json({ error: 'Too many authentication attempts' })
    }
    return next()
  }
}

export function resetAuthRateLimit() { buckets.clear() }
export default createAuthRateLimit()