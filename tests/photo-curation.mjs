import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'
import { jpegBase64 } from './helpers/images.mjs'
import { publicationPhotoPayload, recommendPhotos } from '../server/services/photo-curation.ts'

const suggestions = recommendPhotos([
  { id: 1, category: 'other' },
  { id: 2, category: 'other' },
  { id: 3, category: 'interior' },
  { id: 4, category: 'other' },
  { id: 5, category: 'front' },
  { id: 6, category: 'rear' },
  { id: 7, category: 'engine' },
  { id: 8, category: 'detail' },
  { id: 9, category: 'other' },
  { id: 10, category: 'other' },
])
assert.equal(suggestions.length, 8)
assert.equal(suggestions[0], 5, 'Recognized front photo should be recommended as cover')
assert(suggestions.includes(3) && suggestions.includes(6) && suggestions.includes(7))
assert.deepEqual(recommendPhotos([], 8), [])

const server = await startTestServer()
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
const anonymous = createApiClient(server.base, '')
try {
  const login = await anonymous('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const api = createApiClient(server.base, login.token)
  const org = db
    .prepare('SELECT organization_id org FROM users WHERE email=?')
    .get(server.email).org
  const created = await api('/vehicles', {
    method: 'POST',
    body: JSON.stringify({
      year: 2022,
      make: 'Toyota',
      model: 'Corolla',
      price: 92000,
      km: 35000,
      vehicleType: 'Carro/picape',
      bodyType: 'Sedã',
      condition: 'Bom',
      status: 'Pronto',
      location: 'Criciúma, SC',
      description: 'Veículo disponível.',
      transmission: 'Automático',
      fuelType: 'Flex',
      exteriorColor: 'Preto',
      interiorColor: 'Preto',
    }),
  })
  const id = created.id
  const root = '/vehicles/' + id + '/photos'
  const send = (path, body, method = 'POST') => api(path, { method, body: JSON.stringify(body) })
  const fail = (operation, code) => assert.rejects(operation, (e) => e.status === code)
  const upload = async (label) =>
    api('/vehicles/' + id + '/images', {
      method: 'POST',
      body: JSON.stringify({
        name: label + '.jpg',
        mimeType: 'image/jpeg',
        dataBase64: jpegBase64(label),
      }),
    })
  const images = []
  for (let i = 1; i <= 10; i++) images.push(await upload('photo-' + i))
  const loaded = await api(root + '/curation')
  assert.equal(loaded.images.length, 10)
  assert.equal(loaded.preferredCount, 8)
  assert.equal(loaded.approved, false)
  assert.equal(loaded.automatic, true)
  assert.equal(loaded.needsReview, false)
  assert.equal(loaded.recommendation.length, 8)
  assert.deepEqual(loaded.selectedIds, loaded.recommendation)
  const autoPayload = publicationPhotoPayload(db, org, id, '/uploads/')
  assert.equal(autoPayload.length, 8, 'Unreviewed real photos should publish automatically')
  assert.equal(autoPayload[0].name, 'photo-1.jpg')
  await fail(() => anonymous(root + '/curation'), 401)
  await fail(
    () => send(root + '/' + images[0].id + '/category', { category: 'secret' }, 'PATCH'),
    400,
  )
  await send(root + '/' + images[0].id + '/category', { category: 'front' }, 'PATCH')
  await send(root + '/' + images[4].id + '/category', { category: 'interior' }, 'PATCH')
  const categorized = await api(root + '/curation')
  assert.equal(categorized.recommendation[0], images[0].id)
  assert(categorized.recommendation.includes(images[4].id))

  const selectedIds = [images[3].id, ...images.slice(0, 3).map((item) => item.id)]
  await fail(
    () =>
      send(root + '/selection', {
        photoIds: [images[0].id, images[0].id],
        fingerprint: categorized.fingerprint,
      }),
    400,
  )
  await fail(
    () =>
      send(root + '/selection', {
        photoIds: [images[0].id, 90000000],
        fingerprint: categorized.fingerprint,
      }),
    400,
  )
  await send(root + '/selection', { photoIds: selectedIds, fingerprint: categorized.fingerprint })
  const approved = await api(root + '/curation')
  assert.equal(approved.approved, true)
  assert.deepEqual(approved.selectedIds, selectedIds)
  const payload = publicationPhotoPayload(db, org, id, '/uploads/')
  assert.equal(payload.length, 4)
  assert.equal(payload[0].name, 'photo-4.jpg', 'Approved cover must be first')
  assert.equal(payload[3].name, 'photo-3.jpg')

  await upload('new-photo')
  const stale = await api(root + '/curation')
  assert.equal(stale.needsReview, false)
  assert.equal(stale.automatic, true)
  assert.equal(stale.selectionOutdated, true)
  assert.equal(publicationPhotoPayload(db, org, id, '/uploads/').length, 8)
  await fail(
    () =>
      send(root + '/selection', {
        photoIds: stale.recommendation,
        fingerprint: categorized.fingerprint,
      }),
    409,
  )
  await send(root + '/selection', {
    photoIds: stale.recommendation,
    fingerprint: stale.fingerprint,
  })
  assert.equal(publicationPhotoPayload(db, org, id, '/uploads/').length, 8)

  const secondOrg = Number(
    db.prepare("INSERT INTO organizations(name) VALUES('Outra')").run().lastInsertRowid,
  )
  const foreign = Number(
    db
      .prepare(
        "INSERT INTO vehicles (organization_id,year,make,model) VALUES (?,2022,'Toyota','Yaris')",
      )
      .run(secondOrg).lastInsertRowid,
  )
  await fail(() => api('/vehicles/' + foreign + '/photos/curation'), 404)

  const pending = Number(
    db
      .prepare(
        "INSERT INTO publication_jobs(organization_id,vehicle_id,status) VALUES (?,?,'pending')",
      )
      .run(org, id).lastInsertRowid,
  )
  await fail(
    () =>
      send(root + '/selection', {
        photoIds: stale.recommendation,
        fingerprint: stale.fingerprint,
      }),
    409,
  )
  await fail(() => api(root + '/selection', { method: 'DELETE' }), 409)
  await fail(
    () => send(root + '/' + images[0].id + '/category', { category: 'rear' }, 'PATCH'),
    409,
  )
  db.prepare('DELETE FROM publication_jobs WHERE id=?').run(pending)

  await api(root + '/selection', { method: 'DELETE' })
  const automaticAgain = await api(root + '/curation')
  assert.equal(automaticAgain.enabled, false)
  assert.equal(automaticAgain.automatic, true)
  assert.equal(publicationPhotoPayload(db, org, id, '/uploads/').length, 8)
  // A corrupted persisted *current* selection remains a hard error.
  db.prepare(
    "INSERT INTO vehicle_photo_selections(organization_id,vehicle_id,photo_ids,inventory_fingerprint) VALUES(?,?,?,?)",
  ).run(org, id, '[99999999]', automaticAgain.fingerprint)
  assert.equal((await api(root + '/curation')).needsReview, true)
  assert.throws(
    () => publicationPhotoPayload(db, org, id, '/uploads/'),
    /Seleção de fotografias inconsistente/,
  )
  db.prepare(
    'DELETE FROM vehicle_photo_selections WHERE organization_id=? AND vehicle_id=?',
  ).run(org, id)

  console.log(
    '✓ Photo curation: automatic real-photo selection, optional custom cover, tenant isolation and stale fallback',
  )
} finally {
  db.close()
  await server.close()
}
