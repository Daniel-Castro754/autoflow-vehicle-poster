import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'

const server = await startTestServer({ GOOGLE_STOCK_CLIENT_ID: '', GOOGLE_STOCK_CLIENT_SECRET: '' })
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
try {
  const unauth = createApiClient(server.base, '')
  const login = await unauth('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const admin = createApiClient(server.base, login.token)
  const denied = (fn, status) => assert.rejects(fn, (error) => error.status === status)

  await denied(() => unauth('/google-stock/status'), 401)
  const initial = await admin('/google-stock/status')
  assert.equal(initial.connected, false)
  assert.equal(initial.oauthConfigured, false)
  assert.equal(initial.automaticImport, false)
  assert.equal(initial.automaticPublication, false)

  const sheetId = '1_g-qQxmXXN21CddcuNKs05ltYiLkwHly_HcrJ0DpAOw'
  const folderId = '1j3IoVthjsQNW6r1b_6gKSJWmCXh1CRlr'
  const config = await admin('/google-stock/config', {
    method: 'POST',
    body: JSON.stringify({
      spreadsheetId: 'https://docs.google.com/spreadsheets/d/' + sheetId + '/edit',
      rootFolderId: 'https://drive.google.com/drive/folders/' + folderId,
    }),
  })
  assert.equal(config.spreadsheetId, sheetId)
  assert.equal(config.rootFolderId, folderId)
  const after = await admin('/google-stock/status')
  assert.equal(after.connected, false)
  assert.equal(after.spreadsheetId, sheetId)
  assert.equal(after.rootFolderId, folderId)
  await denied(
    () => admin('/google-stock/config', { method: 'POST', body: JSON.stringify({ spreadsheetId: 'http://evil', rootFolderId: folderId }) }),
    400,
  )
  await denied(() => admin('/google-stock/connect', { method: 'POST' }), 503)
  await denied(() => admin('/google-stock/prepare', { method: 'POST' }), 409)

  const before = db.prepare('SELECT COUNT(*) count FROM publication_jobs').get().count
  const org = db.prepare('SELECT id organizationId FROM organizations LIMIT 1').get().organizationId
  const adminRow = db.prepare('SELECT password_hash hash FROM users WHERE email=?').get(server.email)
  const sellerEmail = 'seller-stock@test.local'
  db.prepare(
    "INSERT INTO users(organization_id,name,email,password_hash,role,active) VALUES(?,?,?,?, 'seller',1)",
  ).run(org, 'Vendedor', sellerEmail, adminRow.hash)
  const sellerLogin = await unauth('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: sellerEmail, password: server.password }),
  })
  const seller = createApiClient(server.base, sellerLogin.token)
  await denied(() => seller('/google-stock/status'), 403)
  await denied(() => seller('/google-stock/connect', { method: 'POST' }), 403)
  await denied(() => seller('/google-stock/prepare', { method: 'POST' }), 403)
  await denied(
    () => seller('/google-stock/config', {
      method: 'POST',
      body: JSON.stringify({ spreadsheetId: sheetId, rootFolderId: folderId }),
    }),
    403,
  )

  const invalidCallback = await fetch(server.base + '/google-stock/oauth/callback?code=abc&state=bad', { redirect: 'manual' })
  assert.equal(invalidCallback.status, 401)
  const errorCallback = await fetch(server.base + '/google-stock/oauth/callback?error=access_denied', { redirect: 'manual' })
  assert.equal(errorCallback.status, 400)
  assert.equal(db.prepare('SELECT COUNT(*) count FROM publication_jobs').get().count, before)

  await admin('/google-stock/disconnect', { method: 'POST' })
  assert.equal((await admin('/google-stock/status')).connected, false)
  console.log('OK: Google integration admin-only, no publication, safe configuration and fail-closed OAuth')
} finally {
  db.close()
  await server.close()
}
