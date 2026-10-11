import assert from 'node:assert/strict'
import sharp from 'sharp'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'
import { jpegBase64 } from './helpers/images.mjs'

const server = await startTestServer()
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
const loginApi = createApiClient(server.base, '')
try {
  const login = await loginApi('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const api = createApiClient(server.base, login.token)
  const admin = (await api('/team')).users[0]
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      organizationName: 'Teste de anúncios por unidade',
      dailyLimit: 10,
      executionIntervalMinutes: 0,
      autoPublish: false,
    }),
  })
  const account = await api('/social-accounts', {
    method: 'POST',
    body: JSON.stringify({
      userId: admin.id,
      label: 'Conta teste',
      browserProfile: 'Brave teste',
    }),
  })

  async function readyVehicle(photographName) {
    const vehicle = await api('/vehicles', {
      method: 'POST',
      body: JSON.stringify({
        year: 2022,
        make: 'Toyota',
        model: 'Corolla',
        trim: 'XEi',
        price: 92000,
        km: 35000,
        vehicleType: 'Carro/picape',
        bodyType: 'Sedã',
        condition: 'Bom',
        status: 'Pronto',
        location: 'Criciúma, SC',
        description: 'Veículo disponível para consulta.',
        transmission: 'Automático',
        fuelType: 'Flex',
        exteriorColor: 'Preto',
        interiorColor: 'Preto',
      }),
    })
    await api(`/vehicles/${vehicle.id}/images`, {
      method: 'POST',
      body: JSON.stringify({
        name: photographName + '.jpg',
        mimeType: 'image/jpeg',
        dataBase64: jpegBase64(photographName),
      }),
    })
    const curation = await api(`/vehicles/${vehicle.id}/photos/curation`)
    await api(`/vehicles/${vehicle.id}/photos/selection`, {
      method: 'POST',
      body: JSON.stringify({
        photoIds: curation.recommendation,
        fingerprint: curation.fingerprint,
      }),
    })
    return vehicle
  }

  const firstVehicle = await readyVehicle('unit-one')
  const secondVehicle = await readyVehicle('unit-two')
  const makeJob = (vehicleId) =>
    api('/publications', {
      method: 'POST',
      body: JSON.stringify({ vehicleId, accountId: account.id }),
    })
  const first = await makeJob(firstVehicle.id)
  const second = await makeJob(secondVehicle.id)
  const fingerprints = db
    .prepare('SELECT listing_hash FROM published_ads WHERE publication_job_id IN (?,?)')
    .all(first.id, second.id)
  assert.equal(fingerprints.length, 2)
  assert.notEqual(fingerprints[0].listing_hash, fingerprints[1].listing_hash)
  await assert.rejects(
    () => makeJob(firstVehicle.id),
    (error) => error.status === 409,
    'The same stock vehicle may not be published twice just by changing presentation.',
  )

  const prepared = await api(`/extension/jobs/${first.id}/prepare`, {
    method: 'POST',
    body: JSON.stringify({
      accountId: account.id,
      instanceId: 'image_variant_test_worker_one',
      tabId: 121,
      document: '/marketplace/create/vehicle',
    }),
  })
  assert(prepared.vehicle.description.includes(`AF-${String(firstVehicle.id).padStart(6, '0')}`))
  assert(prepared.vehicle.description.includes('Veículo disponível para consulta.'))
  assert.equal(prepared.vehicle.images.length, 1)
  const image = prepared.vehicle.images[0]
  assert.match(image.url, /\/uploads\/variants\/\d+\/\d+\/[a-f0-9]{64}\.jpg$/)
  assert.equal(image.mimeType, 'image/jpeg')
  assert(image.name.endsWith('.jpg'))
  const response = await fetch(image.url)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/jpeg')
  const jpeg = Buffer.from(await response.arrayBuffer())
  assert.equal((await sharp(jpeg).metadata()).format, 'jpeg')
  assert(jpeg.length > 0)
  const repeat = await fetch(image.url)
  assert.equal(repeat.status, 200)
  assert.deepEqual(Buffer.from(await repeat.arrayBuffer()), jpeg)
  const invalid = image.url.replace(/[a-f0-9]{64}\.jpg$/, '0'.repeat(64) + '.jpg')
  assert.equal((await fetch(invalid)).status, 403)
  console.log('✓ Signed images are faithful, stable and limited to approved photos; distinct stock units can be listed.')
} finally {
  db.close()
  await server.close()
}
