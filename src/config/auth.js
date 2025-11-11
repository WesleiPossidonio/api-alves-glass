import * as dotenv from 'dotenv'
dotenv.config()

export default {
  secret: process.env.SECRET_KAY,
  expiresIn: process.env.EXPIRESIN_KAY,
}
