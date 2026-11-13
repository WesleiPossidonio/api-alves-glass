import * as dotenv from 'dotenv'
dotenv.config()

export default {
  secret: process.env.SECRET_KAY || (process.env.NODE_ENV === 'test' ? 'test-only-session-signing-secret-not-for-production' : undefined),
  expiresIn: process.env.EXPIRESIN_KAY,
}
