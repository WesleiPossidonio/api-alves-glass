import { OAuth2Client } from 'google-auth-library'

const getGoogleClientId = () => process.env.GOOGLE_CLIENT_ID || process.env.CLIENT_ID_LOGIN

export default async function verifyGoogleToken(token) {
    const audience = getGoogleClientId()
    if (!audience || typeof token !== 'string' || token.length === 0) {
        throw new Error('Invalid Google Token');
    }
    try {
        const client = new OAuth2Client(audience)
        const ticket = await client.verifyIdToken({
           idToken: token,
           audience,
        });

        const payload = ticket.getPayload()
        if (!payload?.sub || !payload.email_verified) throw new Error('Invalid Google Token');
        return payload
    } catch (error) {
        throw new Error('Invalid Google Token');   
    }

}