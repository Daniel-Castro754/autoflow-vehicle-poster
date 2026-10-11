import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'

const server = await startTestServer()
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
try {
  const anonymous = createApiClient(server.base, '')
  const login = await anonymous('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const api = createApiClient(server.base, login.token)
  const create = (payload) =>
    api('/integrations/credentials', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  const issued = await create({
    name: 'ChatGPT leitura',
    scopes: ['status:read', 'vehicles:read'],
  })
  assert.match(issued.token, /^afi_[A-Za-z0-9_-]{43}$/)
  const org = db
    .prepare('SELECT organization_id id FROM users WHERE email=?')
    .get(server.email).id
  const stored = db
    .prepare(
      'SELECT token_hash hash,organization_id org,active FROM integration_credentials WHERE id=?',
    )
    .get(issued.id)
  assert.equal(stored.hash, createHash('sha256').update(issued.token).digest('hex'))
  assert.equal(stored.org, org)
  assert.equal(stored.active, 1)
  const listed = await api('/integrations/credentials')
  assert(listed.credentials.some((credential) => credential.id === issued.id))
  assert(!JSON.stringify(listed).includes(issued.token))
  assert(!JSON.stringify(listed).includes(stored.hash))
  const integrated = createApiClient(server.base, issued.token)
  const status = await integrated('/integration/v1/status')
  assert.equal(status.readOnly, true)
  const vehicles = await integrated('/integration/v1/vehicles')
  assert(Array.isArray(vehicles.vehicles))
  await assert.rejects(
    integrated('/integration/v1/accounts'),
    (error) => error.status === 403,
  )
  await assert.rejects(
    integrated('/integrations/credentials'),
    (error) => error.status === 401,
  )
  await assert.rejects(
    create({ name: 'Invalid', scopes: ['vehicles:write'] }),
    (error) => error.status === 400,
  )
  await assert.rejects(
    create({ name: 'Duplicated', scopes: ['status:read', 'status:read'] }),
    (error) => error.status === 400,
  )
  await assert.rejects(
    create({ name: 'Expired', scopes: ['status:read'], expiresAt: '2020-01-01T00:00:00.000Z' }),
    (error) => error.status === 400,
  )
  const foreignOrg = Number(
    db.prepare("INSERT INTO organizations(name) VALUES('Outro tenant')").run().lastInsertRowid,
  )
  const foreign = db
    .prepare(
      'INSERT INTO integration_credentials (organization_id,name,token_hash,scopes) VALUES (?,?,?,?)',
    )
    .run(foreignOrg, 'Segredo externo', 'f'.repeat(64), '["status:read"]')
  assert(!JSON.stringify(await api('/integrations/credentials')).includes('Segredo externo'))
  await assert.rejects(
    api(`/integrations/credentials/${foreign.lastInsertRowid}/revoke`, { method: 'POST' }),
    (error) => error.status === 404,
  )
  const revoked = await api(`/integrations/credentials/${issued.id}/revoke`, { method: 'POST' })
  assert.equal(revoked.revoked, true)
  await assert.rejects(integrated('/integration/v1/status'), (error) => error.status === 401)
  await assert.rejects(
    api(`/integrations/credentials/${issued.id}/revoke`, { method: 'POST' }),
    (error) => error.status === 404,
  )
  const audit = db
    .prepare('SELECT action,outcome FROM integration_audit_events WHERE organization_id=?')
    .all(org)
  assert(audit.some((event) => event.action === 'credential:create'))
  assert(audit.some((event) => event.action === 'credential:revoke'))
  assert(audit.some((event) => event.action === 'accounts:read' && event.outcome === 'denied'))
  console.log(
    '✓ Integration credentials: scope, hashing, tenant isolation, audit and revocation',
  )
} finally {
  db.close()
  await server.close()
}
