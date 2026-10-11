import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { generateListingTextVariants, renderListingTemplate } from '../server/services/listing-generator.ts'
import { approveListingTextPreview } from '../server/services/listing-text-previews.ts'
import { startTestServer, createApiClient } from './helpers/server.mjs'

const vehicleFacts = {
  year: 2022,
  make: 'Toyota',
  model: 'Corolla',
  trim: 'XEi',
  price: 109000,
  km: 25000,
  transmission: 'Automático',
  fuelType: 'Flex',
  exteriorColor: 'Preto',
  location: 'Criciúma - SC',
}
const variants = generateListingTextVariants(vehicleFacts)
assert.equal(variants.length, 3)
assert.equal(new Set(variants.map((variant) => variant.description)).size, 3)
for (const item of variants) {
  assert.match(item.title, /Toyota Corolla/)
  assert.match(item.description, /25\.000 km/)
  assert.match(item.description, /109\.000/)
  assert.match(item.description, /Flex/)
  assert.doesNotMatch(item.description, /IPVA pago|único dono|revisado|financiamento disponível/i)
}
const reduced = generateListingTextVariants({
  year: 2024,
  make: 'Honda',
  model: 'Civic',
  price: 75000,
  km: 0,
})
assert(reduced.every((item) => !item.description.includes('undefined')))
assert(reduced.every((item) => !item.description.includes('Câmbio:')))
assert.throws(() => generateListingTextVariants({ ...vehicleFacts, price: 0 }))
assert.throws(() => generateListingTextVariants({ ...vehicleFacts, km: -1 }))
assert.throws(() => generateListingTextVariants({ ...vehicleFacts, make: 'X{falso}' }))
assert.throws(() => generateListingTextVariants(vehicleFacts, 'invented'))
assert.equal(
  renderListingTemplate('{Dados|Informações} {marca}', { marca: 'Toyota' }, 0),
  'Dados Toyota',
)
assert.equal(
  renderListingTemplate('{Dados|Informações} {marca}', { marca: 'Toyota' }, 1),
  'Informações Toyota',
)
assert.throws(() => renderListingTemplate('{IPVA_pago}', {}, 0))
assert.throws(() => renderListingTemplate('{a|{b|c}}', {}, 0))
assert.throws(() => renderListingTemplate('{a|b}', {}, -1))
assert.throws(() => renderListingTemplate('{a|b|c|d|e|f|g|h|i}', {}, 0))

const server = await startTestServer()
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
const anonymous = createApiClient(server.base, '')
const fail = (task, expected) => assert.rejects(task, (e) => e.status === expected)
try {
  const logged = await anonymous('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const api = createApiClient(server.base, logged.token)
  const organization = db
    .prepare('SELECT organization_id id FROM users WHERE email=?')
    .get(server.email).id

  const created = await api('/vehicles', {
    method: 'POST',
    body: JSON.stringify({
      ...vehicleFacts,
      vehicleType: 'Carro/picape',
      bodyType: 'Sedã',
      condition: 'Excelente',
      interiorColor: 'Preto',
      description: 'Descrição original.',
      status: 'Rascunho',
    }),
  })
  const current = () =>
    db.prepare('SELECT description FROM vehicles WHERE id=?').get(created.id).description
  const preview = () => api('/ai/listing-text/preview', {
    method: 'POST',
    body: JSON.stringify({ vehicleId: created.id }),
  })
  const approve = (previewId, variantId = 1) => api('/ai/listing-text/approve', {
    method: 'POST',
    body: JSON.stringify({ previewId, variantId }),
  })

  await fail(() => anonymous('/ai/listing-text/preview', {
    method: 'POST',
    body: JSON.stringify({ vehicleId: created.id }),
  }), 401)
  await fail(() => approve(undefined), 428)
  await fail(() => api('/ai/listing-text/preview', {
    method: 'POST',
    body: JSON.stringify({ vehicleId: 'invalid' }),
  }), 409)

  const first = await preview()
  assert.equal(first.requiresApproval, true)
  assert.equal(first.style, 'balanced')
  assert.equal(first.variants.length, 3)
  assert.equal(current(), 'Descrição original.', 'The preview must be read-only')
  await fail(() => approve(first.previewId, 99), 409)

  // Approval must be scoped to the requesting user and organization.
  const foreignOrg = Number(
    db.prepare("INSERT INTO organizations(name) VALUES('Outra organização')").run().lastInsertRowid,
  )
  assert.throws(() =>
    approveListingTextPreview(db, foreignOrg, logged.user.id, first.previewId, 1),
  )
  assert.equal(current(), 'Descrição original.')

  db.prepare('UPDATE vehicles SET price=? WHERE id=?').run(150000, created.id)
  await fail(() => approve(first.previewId), 409)
  assert.equal(current(), 'Descrição original.', 'A stale preview cannot change the vehicle')
  db.prepare('UPDATE vehicles SET price=? WHERE id=?').run(109000, created.id)

  // A publication in progress prevents any new text variant from being approved.
  const second = await preview()
  const pendingId = Number(
    db.prepare(
      "INSERT INTO publication_jobs(organization_id,vehicle_id,status) VALUES (?,?,'pending')",
    ).run(organization, created.id).lastInsertRowid,
  )
  await fail(() => approve(second.previewId), 409)
  await fail(() => preview(), 409)
  assert.equal(current(), 'Descrição original.')
  db.prepare('DELETE FROM publication_jobs WHERE id=?').run(pendingId)

  const third = await preview()
  const selected = third.variants[1]
  const approved = await approve(third.previewId, selected.id)
  assert.equal(approved.approvedVariantId, selected.id)
  assert.equal(current(), selected.description)
  await fail(() => approve(third.previewId, selected.id), 409)

  console.log('✓ Listing text: approved variants, truthful facts, scoped preview, stale and duplicate guards')
} finally {
  db.close()
  await server.close()
}
