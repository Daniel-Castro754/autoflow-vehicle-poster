import { hashPassword, passwordNeedsUpgrade } from '../lib/passwords.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'

type AuthContext = { userId: number; organizationId: number; sessionId?: string }
type UserRow = Record<string, unknown> & {
  id: number
  organization_id: number
  password_hash: string
  active?: number
}
type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  jsonBody: (req: IncomingMessage) => Promise<unknown>
  userById: (id: number) => unknown
  verifyPassword: (password: string, stored: string) => Promise<boolean>
  dummyPasswordHash: string
  sign: (payload: object) => string
}

type LoginBucket = { count: number; resetAt: number }
const loginWindowMs =
  Math.max(1, Math.floor(Number(process.env.LOGIN_WINDOW_SECONDS) || 900)) * 1000
const loginMaxAttempts = Math.max(1, Math.floor(Number(process.env.LOGIN_MAX_ATTEMPTS) || 5))
const loginIpMaxAttempts = Math.max(
  loginMaxAttempts,
  Math.floor(Number(process.env.LOGIN_IP_MAX_ATTEMPTS) || 30),
)
const loginBuckets = new Map<string, LoginBucket>()

function reserveLoginAttempt(key: string, limit: number) {
  const now = Date.now()
  if (loginBuckets.size > 2000) {
    for (const [entry, value] of loginBuckets) if (value.resetAt <= now) loginBuckets.delete(entry)
    while (loginBuckets.size > 1000) loginBuckets.delete(loginBuckets.keys().next().value!)
  }
  const current = loginBuckets.get(key)
  if (current && current.resetAt > now && current.count >= limit)
    return Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  loginBuckets.set(
    key,
    current && current.resetAt > now
      ? { ...current, count: current.count + 1 }
      : { count: 1, resetAt: now + loginWindowMs },
  )
  return 0
}

export async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext | undefined,
  dependencies: Dependencies,
): Promise<boolean> {
  const { db, send, jsonBody, userById, verifyPassword, dummyPasswordHash, sign } = dependencies
  if (req.method === 'GET' && url.pathname === '/api/health') {
    send(res, 200, { ok: true })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const { email, password } = (await jsonBody(req)) as { email?: string; password?: string }
    const normalizedEmail = String(email || '')
      .trim()
      .toLowerCase()
      .slice(0, 254)
    const suppliedPassword = String(password || '')
    const remoteAddress = req.socket.remoteAddress || 'unknown'
    const accountKey = `account:${remoteAddress}:${normalizedEmail}`
    const retryAfter = Math.max(
      reserveLoginAttempt(`ip:${remoteAddress}`, loginIpMaxAttempts),
      reserveLoginAttempt(accountKey, loginMaxAttempts),
    )
    if (retryAfter) {
      res.setHeader('Retry-After', String(retryAfter))
      send(res, 429, { error: 'Muitas tentativas de acesso. Aguarde antes de tentar novamente.' })
      return true
    }
    const row = db
      .prepare('SELECT * FROM users WHERE lower(email)=lower(?)')
      .get(normalizedEmail) as UserRow | undefined
    const passwordValid =
      suppliedPassword.length <= 512 &&
      (await verifyPassword(suppliedPassword, row ? String(row.password_hash) : dummyPasswordHash))
    if (!row || !passwordValid || Number(row.active ?? 1) !== 1) {
      send(res, 401, { error: 'E-mail ou senha inválidos.' })
      return true
    }
    if (passwordNeedsUpgrade(String(row.password_hash))) {
      const upgraded = await hashPassword(suppliedPassword)
      db.prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?').run(
        upgraded,
        row.id,
        row.password_hash,
      )
    }
    loginBuckets.delete(accountKey)
    const sessionId = randomBytes(24).toString('hex')
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    db.prepare(
      "DELETE FROM auth_sessions WHERE datetime(expires_at)<=CURRENT_TIMESTAMP OR (revoked_at IS NOT NULL AND datetime(revoked_at)<=datetime('now','-30 days'))",
    ).run()
    db.prepare(
      'INSERT INTO auth_sessions (id,user_id,organization_id,expires_at) VALUES (?,?,?,?)',
    ).run(sessionId, Number(row.id), Number(row.organization_id), expiresAt)
    const user = userById(Number(row.id))
    send(res, 200, {
      token: sign({ userId: row.id, organizationId: row.organization_id, sessionId }),
      user,
    })
    return true
  }
  if (!auth) return false
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    if (!auth.sessionId) {
      send(res, 401, { error: 'Sessão inválida ou expirada.' })
      return true
    }
    db.prepare(
      'UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND revoked_at IS NULL',
    ).run(auth.sessionId, auth.userId)
    send(res, 200, { ok: true })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/me') {
    send(res, 200, { user: userById(auth.userId) })
    return true
  }
  return false
}
