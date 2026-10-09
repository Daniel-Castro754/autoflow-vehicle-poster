import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'

const server = await startTestServer({ LOGIN_IP_MAX_ATTEMPTS: '200' })
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
const origin = `chrome-extension://${'a'.repeat(32)}`
const loginPayload = JSON.stringify({
  email: server.email,
  password: server.password,
  extensionClient: true,
})
const anon = createApiClient(server.base, '')
const fail = (operation, status) =>
  assert.rejects(operation, (error) => error.status === status)

try {
  const ordinary = await anon('/auth/login', { method: 'POST', body: loginPayload })
  assert.equal(ordinary.refreshToken, undefined, 'No extension origin means no refresh grant')

  const extension = await anon('/auth/login', {
    method: 'POST',
    headers: { Origin: origin },
    body: loginPayload,
  })
  assert.match(extension.refreshToken, /^[a-f0-9]{48}\.[a-zA-Z0-9_-]{43}$/)
  assert.equal((await createApiClient(server.base, extension.token)('/me')).user.email, server.email)
  const sessionId = extension.refreshToken.split('.')[0]
  const stored = db
    .prepare('SELECT secret_hash secretHash FROM extension_refresh_sessions WHERE session_id=?')
    .get(sessionId)
  assert(stored.secretHash)
  assert(!stored.secretHash.includes(extension.refreshToken.split('.')[1]), 'The grant must be hashed')

  const refresh = (grant, headers = { Origin: origin }) =>
    anon('/auth/extension/refresh', {
      method: 'POST',
      headers,
      body: JSON.stringify({ refreshToken: grant }),
    })

  await fail(() => refresh(extension.refreshToken, { Origin: 'https://evil.example' }), 403)
  await fail(() => refresh('malformed'), 401)

  // Exercise true access expiry while a revocable extension refresh grant remains valid.
  db.prepare("UPDATE auth_sessions SET expires_at=datetime('now','-2 hours') WHERE id=?").run(
    sessionId,
  )
  await fail(() => createApiClient(server.base, extension.token)('/me'), 401)
  const renewed = await refresh(extension.refreshToken)
  assert(renewed.token)
  assert(renewed.refreshToken)
  assert.notEqual(renewed.refreshToken, extension.refreshToken, 'Grant rotates after every refresh')
  await fail(() => refresh(extension.refreshToken), 401)
  const active = createApiClient(server.base, renewed.token)
  assert.equal((await active('/me')).user.email, server.email)
  const renewedTwice = await refresh(renewed.refreshToken)
  assert.notEqual(renewedTwice.refreshToken, renewed.refreshToken)

  // Logout invalidates both access and refresh capabilities.
  await createApiClient(server.base, renewedTwice.token)('/auth/logout', { method: 'POST' })
  await fail(() => refresh(renewedTwice.refreshToken), 401)
  await fail(() => createApiClient(server.base, renewedTwice.token)('/me'), 401)

  // A user disabled by an administrator cannot obtain new access with an old refresh grant.
  const third = await anon('/auth/login', {
    method: 'POST',
    headers: { Origin: origin },
    body: loginPayload,
  })
  db.prepare('UPDATE users SET active=0 WHERE email=?').run(server.email)
  await fail(() => refresh(third.refreshToken), 401)
  console.log('✓ Rotating extension grants: origin, expiry, replay, logout, disabled users')
} finally {
  db.close()
  await server.close()
}
