import { randomBytes } from 'node:crypto'
import { OAuth2Client } from 'google-auth-library'

const LIFETIME_MS = 5 * 60 * 1000
const MAX_PENDING = 1000
type Pending = { origin: string; expiresAt: number }
type Identity = { subject: string; email: string }
type Link = Identity & { userId: number }

export class GoogleSignInError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Tokens live only in server memory and in the initiating page's closure, never in URLs
// or browser storage. The separate nonce is the only value sent to Google.
function pendingStore<T>() {
  const values = new Map<string, T & Pending>()
  return {
    put(value: T, origin: string) {
      for (const [key, item] of values) if (item.expiresAt <= Date.now()) values.delete(key)
      if (values.size >= MAX_PENDING)
        throw new GoogleSignInError(
          429,
          'Muitas conexões em andamento. Tente novamente em instantes.',
        )
      const token = randomBytes(32).toString('base64url')
      values.set(token, { ...value, origin, expiresAt: Date.now() + LIFETIME_MS })
      return token
    },
    take(token: unknown, origin: string) {
      const item = typeof token === 'string' ? values.get(token) : undefined
      if (typeof token === 'string') values.delete(token)
      if (!item || item.expiresAt <= Date.now() || item.origin !== origin)
        throw new GoogleSignInError(401, 'Conexão expirada. Clique em Entrar com Google novamente.')
      return item
    },
  }
}

export function createGoogleSignIn(
  clientId = process.env.GOOGLE_CLIENT_ID?.trim() || '',
  client = new OAuth2Client({ transporterOptions: { timeout: 10000, retry: false } }),
) {
  const challenges = pendingStore<{ nonce: string }>()
  const links = pendingStore<Link>()
  return {
    clientId,
    challenge(origin: string) {
      const nonce = randomBytes(32).toString('base64url')
      return { nonce, challengeToken: challenges.put({ nonce }, origin) }
    },
    async verify(credential: unknown, challengeToken: unknown, origin: string): Promise<Identity> {
      const { nonce } = challenges.take(challengeToken, origin)
      if (!clientId || typeof credential !== 'string' || credential.length > 16384)
        throw new GoogleSignInError(
          401,
          'Não foi possível validar sua conta Google. Tente novamente.',
        )
      try {
        const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId })
        const payload = ticket.getPayload()
        const claims = payload as (typeof payload & { nonce?: string }) | undefined
        if (
          !claims ||
          claims.nonce !== nonce ||
          typeof claims.sub !== 'string' ||
          !claims.sub ||
          claims.sub.length > 255 ||
          typeof claims.email !== 'string' ||
          !/^[^\s@]+@[^\s@]+$/.test(claims.email) ||
          claims.email.length > 254 ||
          claims.email_verified !== true ||
          claims.exp * 1000 <= Date.now() ||
          (claims.azp && claims.azp !== clientId)
        )
          throw new Error('Invalid Google identity')
        return { subject: claims.sub, email: claims.email.trim().toLowerCase() }
      } catch {
        // Do not return/log upstream errors: they can include credentials or claims.
        throw new GoogleSignInError(
          401,
          'Não foi possível validar sua conta Google. Tente novamente.',
        )
      }
    },
    prepareLink(identity: Identity, userId: number, origin: string) {
      return links.put({ ...identity, userId }, origin)
    },
    takeLink(token: unknown, origin: string) {
      return links.take(token, origin)
    },
  }
}
