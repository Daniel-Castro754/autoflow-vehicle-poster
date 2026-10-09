import { hashPassword, passwordNeedsUpgrade } from '../lib/passwords.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { GoogleSignInError, type createGoogleSignIn } from '../services/google-sign-in.ts'

type AuthContext = { userId: number; organizationId: number; sessionId?: string }
type UserRow = Record<string, unknown> & {
  id: number
  organization_id: number
  password_hash: string
  email: string
  google_subject: string | null
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
  googleSignIn: ReturnType<typeof createGoogleSignIn>
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

const EXTENSION_REFRESH_DAYS = 30
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/
const refreshHash = (secret: string) => createHash('sha256').update(secret).digest('hex')

function startSession(
  row: UserRow,
  res: ServerResponse,
  dependencies: Dependencies,
  extensionClient = false,
) {
  const { db, send, sign, userById } = dependencies
  const sessionId = randomBytes(24).toString('hex')
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
  db.prepare(
    `DELETE FROM auth_sessions
     WHERE (datetime(expires_at)<=CURRENT_TIMESTAMP AND NOT EXISTS (
       SELECT 1 FROM extension_refresh_sessions e WHERE e.session_id=auth_sessions.id
         AND datetime(e.expires_at)>CURRENT_TIMESTAMP
     )) OR (revoked_at IS NOT NULL AND datetime(revoked_at)<=datetime('now','-30 days'))`,
  ).run()
  db.prepare(
    'INSERT INTO auth_sessions (id,user_id,organization_id,expires_at) VALUES (?,?,?,?)',
  ).run(sessionId, Number(row.id), Number(row.organization_id), expiresAt)
  const secret = extensionClient ? randomBytes(32).toString('base64url') : null
  if (secret) {
    db.prepare(
      `INSERT INTO extension_refresh_sessions(session_id,secret_hash,expires_at)
       VALUES(?,?,datetime('now','+${EXTENSION_REFRESH_DAYS} days'))`,
    ).run(sessionId, refreshHash(secret))
  }
  res.setHeader('Cache-Control', 'no-store')
  send(res, 200, {
    token: sign({ userId: row.id, organizationId: row.organization_id, sessionId }),
    user: userById(Number(row.id)),
    ...(secret ? { refreshToken: `${sessionId}.${secret}` } : {}),
  })
}

async function handleGoogleRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  dependencies: Dependencies,
) {
  const { db, send, jsonBody, googleSignIn, verifyPassword, dummyPasswordHash } = dependencies
  const path = url.pathname
  if (req.method === 'GET' && path === '/api/auth/google/config') {
    res.setHeader('Cache-Control', 'no-store')
    send(res, 200, { enabled: Boolean(googleSignIn.clientId), clientId: googleSignIn.clientId })
    return true
  }
  if (
    req.method !== 'POST' ||
    !['/api/auth/google/challenge', '/api/auth/google', '/api/auth/google/link'].includes(path)
  )
    return false
  res.setHeader('Cache-Control', 'no-store')
  if (!googleSignIn.clientId) {
    send(res, 503, { error: 'O acesso com Google ainda não foi configurado pelo administrador.' })
    return true
  }
  // CORS validates this origin in server.ts. Require JSON + an explicit web origin:
  // cross-site forms cannot submit credentials, and no redirect/query supplies tokens.
  const origin = req.headers.origin || ''
  if (!/^https?:\/\//.test(origin)) {
    send(res, 403, { error: 'Inicie a conexão com Google pelo painel.' })
    return true
  }
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    send(res, 415, { error: 'Envie a conexão com Google em formato JSON.' })
    return true
  }
  const address = req.socket.remoteAddress || 'unknown'
  const retryAfter = reserveLoginAttempt(
    path.endsWith('/challenge') ? `google-challenge:${address}` : `ip:${address}`,
    loginIpMaxAttempts,
  )
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter))
    send(res, 429, { error: 'Muitas tentativas de acesso. Aguarde antes de tentar novamente.' })
    return true
  }
  try {
    if (path.endsWith('/challenge')) {
      send(res, 200, googleSignIn.challenge(origin))
      return true
    }
    const body = (await jsonBody(req)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(res, 400, { error: 'Dados de conexão inválidos.' })
      return true
    }
    if (path === '/api/auth/google') {
      const identity = await googleSignIn.verify(body.credential, body.challengeToken, origin)
      const linked = db
        .prepare('SELECT * FROM users WHERE google_subject=?')
        .get(identity.subject) as UserRow | undefined
      if (linked && Number(linked.active) === 1) {
        startSession(linked, res, dependencies)
        return true
      }
      const candidates = db
        .prepare('SELECT * FROM users WHERE lower(trim(email))=? LIMIT 2')
        .all(identity.email) as UserRow[]
      const user = candidates.length === 1 ? candidates[0] : undefined
      if (linked || !user || Number(user.active) !== 1 || user.google_subject) {
        send(res, 403, {
          error:
            'Esta conta Google não tem acesso. Use o e-mail cadastrado ou consulte o administrador.',
        })
        return true
      }
      // Always prove ownership of the existing AutoFlow account before linking.
      // email_verified alone does not prove ownership of third-party email addresses.
      send(res, 200, {
        linkRequired: true,
        linkToken: googleSignIn.prepareLink(identity, user.id, origin),
        email: identity.email,
      })
      return true
    }
    const link = googleSignIn.takeLink(body.linkToken, origin)
    const accountKey = `account:${address}:${link.email}`
    const accountRetryAfter = reserveLoginAttempt(accountKey, loginMaxAttempts)
    if (accountRetryAfter) {
      res.setHeader('Retry-After', String(accountRetryAfter))
      send(res, 429, { error: 'Muitas tentativas de acesso. Aguarde antes de tentar novamente.' })
      return true
    }
    const before = db.prepare('SELECT * FROM users WHERE id=?').get(link.userId) as
      UserRow | undefined
    const passwordValid =
      typeof body.password === 'string' &&
      body.password.length <= 512 &&
      (await verifyPassword(body.password, before?.password_hash || dummyPasswordHash))
    // Re-read after password hashing: an administrator may have disabled the user.
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(link.userId) as
      UserRow | undefined
    if (
      !user ||
      !passwordValid ||
      Number(user.active) !== 1 ||
      user.password_hash !== before?.password_hash ||
      user.email.trim().toLowerCase() !== link.email ||
      (user.google_subject && user.google_subject !== link.subject)
    ) {
      send(res, 401, {
        error:
          'Não foi possível vincular. Confira sua senha e inicie a conexão com Google novamente.',
      })
      return true
    }
    const owner = db.prepare('SELECT id FROM users WHERE google_subject=?').get(link.subject)
    if (owner && Number(owner.id) !== user.id) {
      send(res, 409, { error: 'Esta conta Google já está vinculada a outro usuário.' })
      return true
    }
    db.prepare('UPDATE users SET google_subject=? WHERE id=?').run(link.subject, user.id)
    loginBuckets.delete(accountKey)
    startSession(user, res, dependencies)
    return true
  } catch (error) {
    if (!(error instanceof GoogleSignInError)) throw error
    send(res, error.status, { error: error.message })
    return true
  }
}

export async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext | undefined,
  dependencies: Dependencies,
): Promise<boolean> {
  const { db, send, jsonBody, userById, verifyPassword, dummyPasswordHash, sign } = dependencies
  if (req.method === 'POST' && url.pathname === '/api/auth/extension/refresh') {
    res.setHeader('Cache-Control', 'no-store')
    if (!EXTENSION_ORIGIN.test(String(req.headers.origin || ''))) {
      send(res, 403, { error: 'Esta renovação é exclusiva da extensão.' })
      return true
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      send(res, 415, { error: 'Envie um corpo JSON.' })
      return true
    }
    const body = (await jsonBody(req)) as Record<string, unknown> | null
    const value = typeof body?.refreshToken === 'string' ? body.refreshToken : ''
    const match = /^([a-f0-9]{48})\.([A-Za-z0-9_-]{43})$/.exec(value)
    const client = String(req.socket.remoteAddress || 'unknown')
    const delay = reserveLoginAttempt(`extension-refresh:${client}`, 120)
    if (delay) {
      res.setHeader('Retry-After', String(delay))
      send(res, 429, { error: 'Muitas tentativas de renovação.' })
      return true
    }
    if (!match) {
      send(res, 401, { error: 'Renovação inválida. Entre novamente.' })
      return true
    }
    const nextSecret = randomBytes(32).toString('base64url')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare(
        `SELECT s.id sessionId,s.user_id userId,s.organization_id organizationId
         FROM auth_sessions s
         JOIN extension_refresh_sessions e ON e.session_id=s.id
         JOIN users u ON u.id=s.user_id AND u.organization_id=s.organization_id
         WHERE s.id=? AND e.secret_hash=? AND s.revoked_at IS NULL AND u.active=1
           AND datetime(e.expires_at)>CURRENT_TIMESTAMP`,
      ).get(match[1], refreshHash(match[2])) as
        | { sessionId: string; userId: number; organizationId: number }
        | undefined
      if (!row) {
        db.exec('ROLLBACK')
        send(res, 401, { error: 'Renovação expirada ou revogada. Entre novamente.' })
        return true
      }
      db.prepare(
        `UPDATE extension_refresh_sessions SET secret_hash=?,rotated_at=CURRENT_TIMESTAMP
         WHERE session_id=? AND secret_hash=?`,
      ).run(refreshHash(nextSecret), row.sessionId, refreshHash(match[2]))
      db.prepare(
        "UPDATE auth_sessions SET expires_at=datetime('now','+12 hours') WHERE id=?",
      ).run(row.sessionId)
      db.exec('COMMIT')
      send(res, 200, {
        token: sign({
          userId: row.userId,
          organizationId: row.organizationId,
          sessionId: row.sessionId,
        }),
        refreshToken: `${row.sessionId}.${nextSecret}`,
      })
      return true
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (url.pathname.startsWith('/api/auth/google'))
    return handleGoogleRoute(req, res, url, dependencies)
  if (req.method === 'GET' && url.pathname === '/api/health') {
    send(res, 200, { ok: true })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const { email, password, extensionClient } = (await jsonBody(req)) as {
      email?: string
      password?: string
      extensionClient?: boolean
    }
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
    startSession(row, res, dependencies, extensionClient === true && EXTENSION_ORIGIN.test(String(req.headers.origin || '')))
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
