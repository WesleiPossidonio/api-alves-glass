import Database from '../../database/index.js'

class QrPublicRateLimitRepository {
  async consume(originHash, now, windowMs, maxRequests) {
    const windowStartedAt = new Date(Math.floor(now.getTime() / windowMs) * windowMs)
    const expiresAt = new Date(windowStartedAt.getTime() + windowMs * 2)
    return Database.connection.transaction(async transaction => {
      const [rows] = await Database.connection.query(`
        INSERT INTO qr_public_rate_limits(origin_hash, window_started_at, request_count, expires_at)
        VALUES(:originHash, :windowStartedAt, 1, :expiresAt)
        ON CONFLICT(origin_hash) DO UPDATE SET
          window_started_at = EXCLUDED.window_started_at,
          request_count = CASE
            WHEN qr_public_rate_limits.window_started_at = EXCLUDED.window_started_at
              THEN LEAST(:maxRequests + 1, qr_public_rate_limits.request_count + 1)
            ELSE 1
          END,
          expires_at = EXCLUDED.expires_at
        RETURNING request_count
      `, { replacements: { originHash, windowStartedAt, expiresAt, maxRequests }, transaction })
      return Number(rows[0]?.request_count) <= maxRequests
    })
  }
}

export default new QrPublicRateLimitRepository()