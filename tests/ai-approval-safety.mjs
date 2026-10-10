import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'
import { jpegBase64 } from './helpers/images.mjs'

const server = await startTestServer()
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
try {
  const anon = createApiClient(server.base, '')
  const login = await anon('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const api = createApiClient(server.base, login.token)
  const org = db
    .prepare('SELECT organization_id org FROM users WHERE email=?')
    .get(server.email).org
  const createVehicle = (model, status = 'Rascunho') =>
    api('/vehicles', {
      method: 'POST',
      body: JSON.stringify({
        year: 2022,
        make: 'Toyota',
        model,
        trim: 'XEi',
        price: 109000,
        km: 25000,
        vehicleType: 'Carro/picape',
        bodyType: 'Sedã',
        condition: 'Excelente',
        status,
        location: 'Criciúma, SC',
        description: 'Texto curto.',
        transmission: 'Automático',
        fuelType: 'Flex',
        exteriorColor: 'Preto',
        interiorColor: 'Preto',
      }),
    })

  const first = await createVehicle('Corolla')
  const second = await createVehicle('Yaris')
  const current = (id) =>
    db.prepare('SELECT description FROM vehicles WHERE id=?').get(id).description

  // Legacy write endpoints cannot run without a reviewed preview.
  await assert.rejects(
    api('/ai/batch-optimize', {
      method: 'POST',
      body: JSON.stringify({ tone: 'vendedor' }),
    }),
    (e) => e.status === 428,
  )
  await assert.rejects(
    api('/ai/autopilot/run', { method: 'POST', body: '{}' }),
    (e) => e.status === 428,
  )
  const textCommand = await api('/ai/command', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'Otimizar descrições dos veículos' }),
  })
  assert.equal(textCommand.actionTaken, 'preview_descriptions')
  assert.equal(current(first.id), 'Texto curto.')

  const proposal = await api('/ai/batch-optimize/preview', {
    method: 'POST',
    body: JSON.stringify({ tone: 'vendedor' }),
  })
  assert.equal(proposal.proposals.length, 2)
  assert(proposal.previewId)
  assert.equal(current(first.id), 'Texto curto.', 'Preview cannot write descriptions')
  assert.equal(current(second.id), 'Texto curto.')
  assert(proposal.proposals.every((item) => item.proposed.length > 10 && item.provider))
  const otherOrg = Number(
    db.prepare("INSERT INTO organizations(name) VALUES('Outra Loja')").run().lastInsertRowid,
  )
  // Preview identifiers are scoped to a particular user and organization.
  const scoped = await import('../server/services/ai-operation-previews.ts')
  assert.throws(() =>
    scoped.applyBatchDescriptionPreview(db, otherOrg, login.user?.id || 1, proposal.previewId, [
      first.id,
    ]),
  )
  db.prepare('UPDATE vehicles SET price=120000 WHERE id=?').run(first.id)
  await assert.rejects(
    api('/ai/batch-optimize', {
      method: 'POST',
      body: JSON.stringify({
        previewId: proposal.previewId,
        selectedVehicleIds: [first.id, second.id],
      }),
    }),
    (e) => e.status === 409,
  )
  assert.equal(current(second.id), 'Texto curto.', 'Partial changes are forbidden')
  db.prepare('UPDATE vehicles SET price=109000 WHERE id=?').run(first.id)

  const refreshed = await api('/ai/batch-optimize/preview', {
    method: 'POST',
    body: JSON.stringify({ tone: 'vendedor' }),
  })
  const applied = await api('/ai/batch-optimize', {
    method: 'POST',
    body: JSON.stringify({ previewId: refreshed.previewId, selectedVehicleIds: [second.id] }),
  })
  assert.equal(applied.updated, 1)
  assert.equal(current(first.id), 'Texto curto.', 'Unselected proposal must stay unchanged')
  assert.notEqual(current(second.id), 'Texto curto.')
  await assert.rejects(
    api('/ai/batch-optimize', {
      method: 'POST',
      body: JSON.stringify({ previewId: refreshed.previewId, selectedVehicleIds: [first.id] }),
    }),
    (e) => e.status === 409,
  )

  // Manual pilot previews are read-only and one-shot; agent cannot skip approval.
  const candidate = await createVehicle('Corolla Cross', 'Pronto')
  await api('/vehicles/' + candidate.id + '/images', {
    method: 'POST',
    body: JSON.stringify({
      name: 'pilot.jpg',
      mimeType: 'image/jpeg',
      dataBase64: jpegBase64('ai-pilot'),
    }),
  })
  const team = await api('/team')
  const social = await api('/social-accounts', {
    method: 'POST',
    body: JSON.stringify({
      userId: team.users[0].id,
      label: 'Perfil Teste',
      browserProfile: 'Profile 1',
    }),
  })
  db.prepare("UPDATE social_accounts SET status='connected' WHERE id=? AND organization_id=?").run(
    social.id,
    org,
  )
  const pilotPreview = await api('/ai/autopilot/preview')
  assert(pilotPreview.previewId)
  assert(pilotPreview.potentialVehicles.some((item) => item.id === candidate.id))
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM publication_jobs WHERE organization_id=?').get(org).n,
    0,
  )
  const chat = await api('/ai/command', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'Executar piloto automático no estoque pronto' }),
  })
  assert.equal(chat.actionTaken, 'preview_autopilot')
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM publication_jobs WHERE organization_id=?').get(org).n,
    0,
  )
  db.prepare('UPDATE vehicles SET price=100000 WHERE id=?').run(candidate.id)
  await assert.rejects(
    api('/ai/autopilot/run', {
      method: 'POST',
      body: JSON.stringify({ previewId: pilotPreview.previewId }),
    }),
    (e) => e.status === 409,
  )
  db.prepare('UPDATE vehicles SET price=109000 WHERE id=?').run(candidate.id)
  const approvedPilot = await api('/ai/autopilot/preview')
  const result = await api('/ai/autopilot/run', {
    method: 'POST',
    body: JSON.stringify({ previewId: approvedPilot.previewId }),
  })
  assert(result.jobsCreated >= 1)
  await assert.rejects(
    api('/ai/autopilot/run', {
      method: 'POST',
      body: JSON.stringify({ previewId: approvedPilot.previewId }),
    }),
    (e) => e.status === 409,
  )
  console.log(
    '✓ AI safety: preview, explicit batch approval, stale rejection, command isolation, and one-shot pilot',
  )
} finally {
  db.close()
  await server.close()
}
