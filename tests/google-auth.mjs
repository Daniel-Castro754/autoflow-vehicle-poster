import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { OAuth2Client } from 'google-auth-library'
import { createGoogleSignIn } from '../server/services/google-sign-in.ts'
import { startTestServer, createApiClient } from './helpers/server.mjs'

const clientId = 'test-client.apps.googleusercontent.com'
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' })
const temp = await mkdtemp(join(tmpdir(), 'autoflow-google-'))
const keyFile = join(temp, 'google-public.pem')
await writeFile(keyFile, publicKey)
const fixture = new URL('./helpers/google-certificates.mjs', import.meta.url).href
const server = await startTestServer({
  GOOGLE_CLIENT_ID: clientId,
  AUTOFLOW_TEST_GOOGLE_PUBLIC_KEY: keyFile,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${fixture}`,
  LOGIN_IP_MAX_ATTEMPTS: '200',
})
const origin = new URL(server.base).origin
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
const anonymous = createApiClient(server.base, '')
function token(nonce, claims = {}, privateKey = keys.privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString(
    'base64url',
  )
  const now = Math.floor(Date.now() / 1000)
  const body = Buffer.from(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: clientId,
      azp: clientId,
      sub: 'google-admin-1',
      email: server.email,
      email_verified: true,
      iat: now,
      exp: now + 3600,
      nonce,
      ...claims,
    }),
  ).toString('base64url')
  const message = `${header}.${body}`
  return `${message}.${sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url')}`
}
function post(path, body = {}, headers = {}) {
  return anonymous(`/auth/google${path}`, {
    method: 'POST',
    headers: { Origin: origin, ...headers },
    body: JSON.stringify(body),
  })
}
async function googleLogin(claims = {}) {
  const challenge = await post('/challenge')
  return post('', {
    credential: token(challenge.nonce, claims),
    challengeToken: challenge.challengeToken,
  })
}
const rejectsStatus = (operation, status) =>
  assert.rejects(operation, (error) => error.status === status)

try {
  assert.deepEqual(await anonymous('/auth/google/config'), { enabled: true, clientId })
  const headers = await fetch(`${server.base}/auth/google/config`)
  assert.equal(headers.headers.get('cache-control'), 'no-store')
  await rejectsStatus(() => post('/challenge', {}, { Origin: '' }), 403)
  await rejectsStatus(() => post('/challenge', {}, { Origin: 'https://untrusted.example' }), 403)
  await rejectsStatus(() => post('/challenge', {}, { 'Content-Type': 'text/plain' }), 415)
  await rejectsStatus(() => post('', null), 400)

  // Verify real RSA signatures plus audience, issuer, expiry, verified email and nonce.
  for (const claims of [
    { aud: 'another-client' },
    { azp: 'another-client' },
    { iss: 'https://attacker.example' },
    { exp: Math.floor(Date.now() / 1000) - 600 },
    { email_verified: false },
    { nonce: 'wrong-nonce' },
    { nonce: undefined },
    { sub: '' },
  ])
    await rejectsStatus(() => googleLogin(claims), 401)
  const forged = await post('/challenge')
  const badKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  await rejectsStatus(
    () =>
      post('', {
        credential: token(forged.nonce, {}, badKey),
        challengeToken: forged.challengeToken,
      }),
    401,
  )
  await rejectsStatus(
    () => post('', { credential: 'not-a-jwt', challengeToken: forged.challengeToken }),
    401,
  )
  await rejectsStatus(() => googleLogin({ email: 'unknown@gmail.com' }), 403)
  assert.equal(db.prepare('SELECT COUNT(*) total FROM users').get().total, 1)
  assert.equal(db.prepare('SELECT COUNT(*) total FROM auth_sessions').get().total, 0)

  const challenge = await post('/challenge')
  const credential = token(challenge.nonce)
  const first = await post('', { credential, challengeToken: challenge.challengeToken })
  assert.equal(first.linkRequired, true)
  assert.equal(first.token, undefined, 'Matching email alone must never create a session')
  await rejectsStatus(() => post('', { credential, challengeToken: challenge.challengeToken }), 401)
  const wrongOrigin = await post('/challenge')
  await rejectsStatus(
    () =>
      post(
        '',
        {
          credential: token(wrongOrigin.nonce),
          challengeToken: wrongOrigin.challengeToken,
        },
        { Origin: 'http://localhost:5173' },
      ),
    401,
  )
  await rejectsStatus(() => post('/link', { linkToken: first.linkToken, password: 'wrong' }), 401)
  await rejectsStatus(
    () => post('/link', { linkToken: first.linkToken, password: server.password }),
    401,
  )
  assert.equal(db.prepare('SELECT google_subject FROM users').get().google_subject, null)

  const pending = await googleLogin({ email: server.email.toUpperCase() })
  const linked = await post('/link', { linkToken: pending.linkToken, password: server.password })
  assert(linked.token)
  assert.equal(linked.user.email, server.email)
  assert.equal(
    db.prepare('SELECT google_subject FROM users').get().google_subject,
    'google-admin-1',
  )
  await rejectsStatus(
    () => post('/link', { linkToken: pending.linkToken, password: server.password }),
    401,
  )
  const client = createApiClient(server.base, linked.token)
  assert.equal((await client('/me')).user.id, linked.user.id)
  await client('/auth/logout', { method: 'POST' })
  await rejectsStatus(() => client('/me'), 401)

  // The immutable Google subject, not its mutable email, identifies returning users.
  const returning = await googleLogin({ email: 'changed@example.net' })
  assert(returning.token)
  assert.equal(returning.user.id, linked.user.id)
  await rejectsStatus(() => googleLogin({ sub: 'different-google-id' }), 403)
  const passwordLogin = await anonymous('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  assert(passwordLogin.token, 'Password access must remain available after linking')

  // Seller permissions and organization membership come only from the local account.
  const orgId = db
    .prepare("INSERT INTO organizations (name) VALUES ('Other company')")
    .run().lastInsertRowid
  const sellerId = db
    .prepare(
      `INSERT INTO users (organization_id,name,email,password_hash,role)
    SELECT ?,'Seller','seller@example.net',password_hash,'seller' FROM users WHERE id=?`,
    )
    .run(orgId, linked.user.id).lastInsertRowid
  const sellerPending = await googleLogin({
    sub: 'google-seller',
    email: 'seller@example.net',
    role: 'admin',
    organizationId: 1,
  })
  const seller = await post('/link', {
    linkToken: sellerPending.linkToken,
    password: server.password,
  })
  assert.equal(seller.user.role, 'seller')
  assert.equal(seller.user.organizationId, Number(orgId))
  const sellerClient = createApiClient(server.base, seller.token)
  await rejectsStatus(
    () =>
      sellerClient('/team/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Escalation',
          email: 'x@example.net',
          password: server.password,
        }),
      }),
    403,
  )
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(sellerId)
  await rejectsStatus(() => googleLogin({ sub: 'google-seller', email: 'seller@example.net' }), 403)
  await rejectsStatus(() => sellerClient('/me'), 401)

  db.prepare(
    `INSERT INTO users (organization_id,name,email,password_hash,role)
    SELECT organization_id,'Pending','pending@example.net',password_hash,'seller' FROM users WHERE id=?`,
  ).run(linked.user.id)
  const disabledPending = await googleLogin({ sub: 'pending-sub', email: 'pending@example.net' })
  db.prepare("UPDATE users SET active=0 WHERE email='pending@example.net'").run()
  await rejectsStatus(
    () => post('/link', { linkToken: disabledPending.linkToken, password: server.password }),
    401,
  )

  // Challenges and pending links expire without calling Google; verification errors stay generic.
  const verifier = new OAuth2Client()
  verifier.getFederatedSignonCertsAsync = async () => ({
    certs: { 'test-key': publicKey },
    format: 'PEM',
  })
  const service = createGoogleSignIn(clientId, verifier)
  const expiredChallenge = service.challenge(origin)
  const expiredLink = service.prepareLink(
    { subject: 'expiring', email: server.email },
    linked.user.id,
    origin,
  )
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 6 * 60 * 1000
    await rejectsStatus(
      () => service.verify(credential, expiredChallenge.challengeToken, origin),
      401,
    )
    assert.throws(
      () => service.takeLink(expiredLink, origin),
      (error) => error.status === 401,
    )
  } finally {
    Date.now = realNow
  }
  verifier.getFederatedSignonCertsAsync = async () => {
    throw new Error('sensitive upstream response')
  }
  const unavailable = service.challenge(origin)
  await assert.rejects(
    () => service.verify(credential, unavailable.challengeToken, origin),
    (error) => error.status === 401 && !error.message.includes('sensitive'),
  )
  console.log(
    'Google auth: signatures, claims, linking, replay, expiry, access isolation and password fallback passed',
  )
} finally {
  db.close()
  await server.close()
  await rm(temp, { recursive: true, force: true })
}

const disabled = await startTestServer()
try {
  const call = createApiClient(disabled.base, '')
  assert.deepEqual(await call('/auth/google/config'), { enabled: false, clientId: '' })
  await rejectsStatus(() => call('/auth/google/challenge', { method: 'POST' }), 503)
  const login = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: disabled.email, password: disabled.password }),
  })
  assert(login.token)
  console.log('Google disabled: configuration and existing password login passed')
} finally {
  await disabled.close()
}

const limited = await startTestServer({ GOOGLE_CLIENT_ID: clientId, LOGIN_IP_MAX_ATTEMPTS: '5' })
try {
  const url = `${limited.base}/auth/google/challenge`
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers: { Origin: new URL(url).origin, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      200,
    )
  const response = await fetch(url, {
    method: 'POST',
    headers: { Origin: new URL(url).origin, 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 429)
  assert(Number(response.headers.get('retry-after')) > 0)
  console.log('Google auth: rate limit passed')
} finally {
  await limited.close()
}
