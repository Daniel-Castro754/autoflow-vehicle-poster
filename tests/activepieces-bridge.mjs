import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  allowedWebhook,
  mapToDraft,
  parseBridgeEnvelope,
  planDrafts,
} from '../scripts/activepieces-bridge-lib.mjs'
const sample = {
  bridgeVersion: 1,
  mode: 'draft_only',
  dryRun: true,
  blocked: [],
  truncated: false,
  jobs: [
    {
      source: 'activepieces',
      jobId: 'job-001',
      mode: 'draft_only',
      platform: 'facebook_marketplace',
      vehicle: {
        vehicle_id: 'PILOTO-001',
        marca: 'Honda',
        modelo: 'Civic',
        ano_modelo: 2022,
        preco: 109000,
        quilometragem: 28000,
        cidade: 'Curitiba',
        estado: 'PR',
        descricao: 'Rascunho demonstrativo',
        cor: 'Prata',
        cambio: 'Automatico',
        combustivel: 'Flex',
        fotos_json: 'https://example.test/img.jpg',
      },
    },
  ],
}
assert.equal(
  allowedWebhook('http://localhost:8080/api/v1/webhooks/local123/sync').host,
  'localhost:8080',
)
assert.equal(
  allowedWebhook('http://127.0.0.1:8080/api/v1/webhooks/local123/sync').host,
  '127.0.0.1:8080',
)
assert.equal(
  allowedWebhook('https://cloud.activepieces.com/api/v1/webhooks/cloud123/sync').protocol,
  'https:',
)
assert.throws(() => allowedWebhook('http://evil.example/api/v1/webhooks/abc/sync'))
assert.throws(() => allowedWebhook('http://192.168.1.2:8080/api/v1/webhooks/abc/sync'))
assert.throws(() => allowedWebhook('http://localhost:8080/api/v1/webhooks/abc'))
assert.throws(() => allowedWebhook('http://localhost:8080/api/v1/webhooks/abc/sync?token=secret'))
const row = sample.jobs[0]
const blocked = mapToDraft(row)
assert(blocked.errors.includes('bodyType'))
assert(blocked.errors.includes('interiorColor'))
assert(blocked.errors.includes('condition'))
assert.equal(blocked.body.transmission, 'Automático')
assert.equal(blocked.body.exteriorColor, 'Prateado')
assert.equal(blocked.body.status, 'Rascunho')
const overrides = {
  'PILOTO-001': {
    vehicleType: 'Carro/picape',
    bodyType: 'Sedã',
    condition: 'Bom',
    interiorColor: 'Preto',
  },
}
const plan = planDrafts({ status: 200, body: sample }, overrides)
assert.equal(plan.eligible.length, 1)
assert.equal(plan.blocked.length, 0)
assert.equal(plan.eligible[0].body.stockCode, 'PILOTO-001')
assert.equal(plan.eligible[0].body.location, 'Curitiba, PR')
assert.throws(() => parseBridgeEnvelope({ ...sample, mode: 'publish' }))
assert.throws(() => parseBridgeEnvelope({ ...sample, truncated: true }))
assert.throws(() => parseBridgeEnvelope({ ...sample, jobs: [row, row] }))
assert.equal(planDrafts({ ...sample, jobs: [] }).total, 0)
const workdir = join(dirname(fileURLToPath(import.meta.url)), '..')
const stdout = execFileSync(
  process.execPath,
  ['scripts/activepieces-bridge.mjs', '--fixture', 'tests/fixtures/activepieces-bridge.json'],
  { cwd: workdir, encoding: 'utf8' },
)
const parsed = JSON.parse(stdout)
assert.equal(parsed.mode, 'PREVIEW_ONLY')
assert.equal(parsed.sourceJobs, 1)
assert.equal(parsed.blocked.length, 1)
assert.equal(parsed.eligible.length, 0)
assert.throws(() =>
  execFileSync(
    process.execPath,
    [
      'scripts/activepieces-bridge.mjs',
      '--fixture',
      'tests/fixtures/activepieces-bridge.json',
      '--create-drafts',
      '--confirm-drafts',
    ],
    { cwd: workdir, stdio: 'pipe' },
  ),
)
console.log(
  'OK: Activepieces bridge preview, explicit draft gate, schema checks and safe mappings.',
)
