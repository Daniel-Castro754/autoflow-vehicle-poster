import assert from 'node:assert/strict'
import { enqueueSelectedVehicles } from '../src/bulk-publication-queue.ts'

const vehicles = [
  { id: 101, label: 'Corolla', imageCount: 4 },
  { id: 102, label: 'Tracker', imageCount: 0 },
  { id: 103, label: 'Civic', imageCount: 9 },
]
const calls = []
const progress = []
const report = await enqueueSelectedVehicles({
  vehicles: [...vehicles, vehicles[0]],
  accountId: 7,
  create: async (vehicleId, accountId) => {
    calls.push([vehicleId, accountId])
    if (vehicleId === 102) {
      const error = new Error('Complete os dados obrigatórios antes de publicar.')
      error.status = 422
      throw error
    }
    if (vehicleId === 103) {
      const error = new Error('Este veículo já possui um trabalho na fila.')
      error.status = 409
      throw error
    }
    return { id: 501 }
  },
  onProgress: (done, total) => progress.push([done, total]),
})
assert.deepEqual(calls, [[101, 7], [102, 7], [103, 7]])
assert.deepEqual(report.succeeded, [101])
assert.equal(report.total, 3)
assert.equal(report.failed.length, 2)
assert.deepEqual(report.failed.map((item) => item.vehicleId), [102, 103])
assert.match(report.failed[0].reason, /sem fotos cadastradas/i)
assert.match(report.failed[1].reason, /já possui um trabalho/)
assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]])

for (const [input, accountId] of [
  [vehicles, 0],
  [[], 7],
  [Array.from({ length: 26 }, (_, i) => ({ id: i + 1, label: 'V' + i })), 7],
]) {
  await assert.rejects(
    enqueueSelectedVehicles({
      vehicles: input,
      accountId,
      create: async () => assert.fail('Invalid selection should make no API requests'),
    }),
  )
}

const abortCalls = []
const offline = await enqueueSelectedVehicles({
  vehicles,
  accountId: 7,
  create: async (id) => {
    abortCalls.push(id)
    const error = new Error('API indisponível')
    error.status = 0
    throw error
  },
})
assert.deepEqual(abortCalls, [101], 'Should not repeat requests when connection fails')
assert.equal(offline.failed.length, 3)
assert.match(offline.failed[1].reason, /Não enviado/)

// The UI must use the same backend single-vehicle endpoint, not create
// publication_jobs directly and not start a Marketplace publish action.
const fs = await import('node:fs')
const view = fs.readFileSync(new URL('../src/Vehicles.tsx', import.meta.url), 'utf8')
for (const token of [
  'Adicionar à fila ({selected.size})',
  'filtered.filter((vehicle) => selected.has(vehicle.id))',
  '<BulkQueueDrawer',
  "api('/publications', {",
  'onProgress: (done) => setProgress(done)',
  'outcome.failed.map((failure) => failure.vehicleId)',
]) {
  assert(view.includes(token), 'Bulk UI must include: ' + token)
}
console.log('OK: seleção em lote, envio sequencial, validações, erros parciais e offline')
