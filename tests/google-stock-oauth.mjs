import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { initializeCredentialVault, decryptCredential } from '../server/services/credential-vault.ts'
import { createGoogleStockOAuth } from '../server/services/google-stock-provider.ts'

const dir = mkdtempSync(join(tmpdir(), 'autoflow-google-stock-vault-'))
const db = new DatabaseSync(':memory:')
const previousSecret = process.env.AUTH_SECRET
process.env.AUTH_SECRET = 'google-stock-test-32-bytes-secret-12345'
try {
  initializeBaseSchema(db)
  applyMigrations(db)
  initializeCredentialVault(dir)
  const org = Number(db.prepare("INSERT INTO organizations(name) VALUES('Loja')").run().lastInsertRowid)
  const admin = Number(
    db.prepare(
      "INSERT INTO users(organization_id,name,email,password_hash,role,active) " +
      "VALUES(?,'Admin','admin@test.local','test','admin',1)",
    ).run(org).lastInsertRowid,
  )
  const seller = Number(
    db.prepare(
      "INSERT INTO users(organization_id,name,email,password_hash,role,active) " +
      "VALUES(?,'Seller','seller@test.local','test','seller',1)",
    ).run(org).lastInsertRowid,
  )
  const fakeClient = {
    generateAuthUrl: ({ state, scope, access_type, prompt }) => {
      assert.equal(access_type, 'offline')
      assert.equal(prompt, 'consent')
      assert.equal(scope.length, 2)
      assert(scope.every((x) => x.endsWith('.readonly')))
      return 'https://accounts.google.com/o/oauth2/v2/auth?state=' + state
    },
    getToken: async (code) => {
      assert.equal(code, 'AUTH_CODE')
      return { tokens: { refresh_token: 'TEST-REFRESH-DO-NOT-STORE-PLAINTEXT' } }
    },
    setCredentials: (credentials) => {
      fakeClient.lastCredentials = credentials
    },
  }
  const oauth = createGoogleStockOAuth({
    clientId: 'google-test-id',
    clientSecret: 'google-test-secret',
    redirectUri: 'http://localhost:3333/api/google-stock/oauth/callback',
    createClient: () => fakeClient,
  })
  const authUrl = new URL(oauth.start(org, admin))
  const state = authUrl.searchParams.get('state')
  assert(state.length >= 32)
  const connectedOrg = await oauth.complete(db, state, 'AUTH_CODE')
  assert.equal(connectedOrg, org)
  const row = db.prepare(
    'SELECT refresh_token_enc token,connected_by connectedBy FROM google_stock_connections WHERE organization_id=?',
  ).get(org)
  assert(row.token.startsWith('enc:v1:'))
  assert(!row.token.includes('TEST-REFRESH'))
  assert.equal(row.connectedBy, admin)
  assert.equal(
    decryptCredential(row.token, org, 'google_stock_refresh_token'),
    'TEST-REFRESH-DO-NOT-STORE-PLAINTEXT',
  )
  oauth.authorizedClient(db, org)
  assert.equal(fakeClient.lastCredentials.refresh_token, 'TEST-REFRESH-DO-NOT-STORE-PLAINTEXT')
  await assert.rejects(oauth.complete(db, state, 'AUTH_CODE'), /expirada ou inválida/)

  const sellerState = new URL(oauth.start(org, seller)).searchParams.get('state')
  await assert.rejects(oauth.complete(db, sellerState, 'AUTH_CODE'), /Administrador sem permissão/)
  assert.equal(
    db.prepare('SELECT connected_by connectedBy FROM google_stock_connections WHERE organization_id=?').get(org).connectedBy,
    admin,
  )
  console.log('OK: OAuth state one-use, read-only scopes, admin-only callback and encrypted refresh token')
} finally {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  if (previousSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = previousSecret
}
