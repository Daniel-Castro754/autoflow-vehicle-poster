import { jpegBase64 } from './helpers/images.mjs'
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
  const draftPayload = {
    year: 2020,
    make: 'Volkswagen',
    model: 'Saveiro',
    price: 68000,
    km: 80000,
    vehicleType: 'Carro/picape',
    transmission: 'Manual',
    fuelType: 'Flex',
    bodyType: 'Picape',
    condition: 'Bom',
    exteriorColor: 'Branco',
    interiorColor: 'Preto',
    location: 'Criciúma, SC',
    stockCode: 'INTEGRATION-DRAFT-001',
    status: 'Publicado',
  }
  await assert.rejects(
    integrated('/integration/v1/vehicles', {
      method: 'POST',
      body: JSON.stringify(draftPayload),
    }),
    (error) => error.status === 403,
  )
  const writer = await create({
    name: 'Cadastro de rascunhos',
    scopes: ['vehicles:create', 'vehicles:read'],
  })
  const writeApi = createApiClient(server.base, writer.token)
  const draft = await writeApi('/integration/v1/vehicles', {
    method: 'POST',
    body: JSON.stringify(draftPayload),
  })
  assert.equal(draft.status, 'Rascunho')
  assert.equal(draft.requiresReview, true)
  const storedDraft = db
    .prepare(
      'SELECT organization_id organizationId,status,assigned_user_id assignedUserId FROM vehicles WHERE id=?',
    )
    .get(draft.id)
  assert.equal(storedDraft.organizationId, org)
  assert.equal(storedDraft.status, 'Rascunho')
  assert.equal(
    db.prepare('SELECT COUNT(*) count FROM publication_jobs WHERE vehicle_id=?').get(draft.id)
      .count,
    0,
  )
  await assert.rejects(
    writeApi('/integration/v1/vehicles', {
      method: 'POST',
      body: JSON.stringify(draftPayload),
    }),
    (error) => error.status === 409,
  )
  await assert.rejects(
    writeApi('/integration/v1/vehicles', {
      method: 'POST',
      body: JSON.stringify({ ...draftPayload, stockCode: 'INTEGRATION-INVALID', year: 1800 }),
    }),
    (error) => error.status === 400,
  )
  const ownVehicles = await writeApi('/integration/v1/vehicles')
  assert(ownVehicles.vehicles.some((vehicle) => vehicle.id === draft.id))
  assert(
    db
      .prepare(
        "SELECT COUNT(*) count FROM integration_audit_events WHERE organization_id=? AND action='vehicles:create' AND resource_id=?",
      )
      .get(org, draft.id).count > 0,
  )
  const photo = { mimeType: 'image/jpeg', dataBase64: jpegBase64('integration-photo-1') }
  await assert.rejects(
    writeApi(`/integration/v1/vehicles/${draft.id}/photos`, {
      method: 'POST',
      body: JSON.stringify(photo),
    }),
    (error) => error.status === 403,
  )
  const photoCredential = await create({
    name: 'Upload de fotos',
    scopes: ['photos:write'],
  })
  const photoApi = createApiClient(server.base, photoCredential.token)
  const uploaded = await photoApi(`/integration/v1/vehicles/${draft.id}/photos`, {
    method: 'POST',
    body: JSON.stringify(photo),
  })
  assert.equal(uploaded.vehicleId, draft.id)
  assert.equal(uploaded.requiresReview, true)
  const duplicatePhoto = await photoApi(`/integration/v1/vehicles/${draft.id}/photos`, {
    method: 'POST',
    body: JSON.stringify(photo),
  })
  assert.equal(duplicatePhoto.duplicate, true)
  assert.equal(duplicatePhoto.id, uploaded.id)
  await assert.rejects(
    photoApi(`/integration/v1/vehicles/${draft.id}/photos`, {
      method: 'POST',
      body: JSON.stringify({ ...photo, dataBase64: 'invalid' }),
    }),
    (error) => error.status === 400,
  )
  await assert.rejects(
    photoApi('/integration/v1/vehicles/999999999/photos', {
      method: 'POST',
      body: JSON.stringify(photo),
    }),
    (error) => error.status === 404,
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) count FROM vehicle_images WHERE vehicle_id=?').get(draft.id)
      .count,
    1,
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
