import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'
import { calculateOptimalSchedule } from '../server/services/smart-scheduler.ts'
import { organizationScheduleHistory } from '../server/services/schedule-history.ts'
import { localParts } from '../server/lib/timezone.ts'

const oldRandom = Math.random
Math.random = () => 0.5
try {
  const referenceDate = new Date('2026-06-15T13:00:00Z')
  const choice = calculateOptimalSchedule({
    referenceDate,
    historicalData: [
      { dayOfWeek: 1, hour: 12, attemptCount: 40, successCount: 12 },
      { dayOfWeek: 1, hour: 13, attemptCount: 10, successCount: 9 },
    ],
  })
  assert.equal(choice.confidence, 'historical')
  assert.equal(localParts(choice.scheduledAt).hour, 13, 'Rate should outrank raw volume')
  const sparse = calculateOptimalSchedule({
    referenceDate,
    historicalData: [{ dayOfWeek: 1, hour: 13, attemptCount: 4, successCount: 4 }],
  })
  assert.equal(sparse.confidence, 'peak_heuristic', 'Sparse history must not bias scheduling')
  const delayed = calculateOptimalSchedule({
    referenceDate,
    historicalData: [
      { dayOfWeek: 6, hour: 12, attemptCount: 20, successCount: 19 },
    ],
  })
  assert.equal(delayed.confidence, 'peak_heuristic', 'Do not wait a week for the top slot')
} finally {
  Math.random = oldRandom
}

const server = await startTestServer()
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
const anonymous = createApiClient(server.base, '')
const fail = (operation, code) =>
  assert.rejects(operation, (error) => error.status === code)
const csvHeader =
  'ID Estoque;Ano;Marca;Modelo;Preço;KM;Tipo Veículo;Localização;Câmbio;Combustível;Carroceria;Cor Externa;Cor Interna;Condição;Descrição;Status'
const csvRow = (code, price, status = 'Rascunho') =>
  `${code};2022;Toyota;Corolla;${price};12000;Carro/picape;Içara - SC;Automático;Flex;Sedã;Preto;Preto;Bom;Toyota revisado;${status}`
const requestImport = (client, csv, more = {}) =>
  client('/vehicles/import', {
    method: 'POST',
    body: JSON.stringify({ csv, mode: 'update', ...more }),
  })
try {
  const login = await anonymous('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const admin = createApiClient(server.base, login.token)
  const org = db.prepare('SELECT organization_id org FROM users WHERE email=?').get(server.email).org
  const org2 = Number(db.prepare("INSERT INTO organizations(name) VALUES('Outra loja')").run().lastInsertRowid)
  const first = `${csvHeader}\n${csvRow('SYNC-1', 98000)}`
  await fail(() => anonymous('/operations/scheduling-insights'), 401)
  assert.equal((await admin('/operations/scheduling-insights')).eligible, false)

  const pre = await requestImport(admin, first, { dryRun: true })
  assert.equal(pre.created, 1)
  assert.match(pre.previewDigest, /^[a-f0-9]{64}$/)
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM vehicles WHERE organization_id=?').get(org).n,
    0,
    'Dry run must roll back all SQL writes',
  )
  const committed = await requestImport(admin, first, { previewDigest: pre.previewDigest })
  assert.equal(committed.created, 1)
  const vehicle = db.prepare(
    "SELECT id,price FROM vehicles WHERE organization_id=? AND stock_code='SYNC-1'",
  ).get(org)
  assert.equal(vehicle.price, 98000)
  const nextCsv = `${csvHeader}\n${csvRow('SYNC-1', 102000)}`
  const updatePreview = await requestImport(admin, nextCsv, { dryRun: true })
  assert.equal(updatePreview.updated, 1)
  assert.equal(db.prepare('SELECT price FROM vehicles WHERE id=?').get(vehicle.id).price, 98000)

  // If another process updates stock between preview and confirmation, reject commit.
  db.prepare('UPDATE vehicles SET price=99000 WHERE id=?').run(vehicle.id)
  await fail(
    () => requestImport(admin, nextCsv, { previewDigest: updatePreview.previewDigest }),
    409,
  )
  assert.equal(db.prepare('SELECT price FROM vehicles WHERE id=?').get(vehicle.id).price, 99000)
  const freshPreview = await requestImport(admin, nextCsv, { dryRun: true })
  const updated = await requestImport(admin, nextCsv, { previewDigest: freshPreview.previewDigest })
  assert.equal(updated.updated, 1)
  assert.equal(db.prepare('SELECT price FROM vehicles WHERE id=?').get(vehicle.id).price, 102000)

  const job = Number(
    db.prepare("INSERT INTO publication_jobs(organization_id,vehicle_id,status) VALUES (?,?,'pending')")
      .run(org, vehicle.id).lastInsertRowid,
  )
  const blocked = await requestImport(admin, `${csvHeader}\n${csvRow('SYNC-1', 125000)}`, {
    dryRun: true,
  })
  assert.equal(blocked.updated, 0)
  assert.equal(blocked.skipped, 1)
  assert.match(blocked.errors[0].error, /publicação ativa/)
  const applied = await requestImport(admin, `${csvHeader}\n${csvRow('SYNC-1', 125000)}`, {
    previewDigest: blocked.previewDigest,
  })
  assert.equal(applied.updated, 0)
  assert.equal(db.prepare('SELECT price FROM vehicles WHERE id=?').get(vehicle.id).price, 102000)
  assert.equal(db.prepare('SELECT status FROM publication_jobs WHERE id=?').get(job).status, 'pending')

  const sold = await requestImport(admin, `${csvHeader}\n${csvRow('SYNC-2', 99000, 'Vendido')}`, {
    dryRun: true,
  })
  assert.equal(sold.failed, 1)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM vehicles WHERE stock_code='SYNC-2'").get().n, 0)

  // Cross-organization stock cannot be counted as a conflict or used for scheduling.
  db.prepare(
    "INSERT INTO vehicles(organization_id,year,make,model,stock_code,status) VALUES (?,2022,'Toyota','Corolla','SYNC-1','Rascunho')",
  ).run(org2)
  const sameSkuPreview = await requestImport(admin, `${csvHeader}\n${csvRow('SYNC-1', 130000)}`, {
    dryRun: true,
  })
  assert.equal(sameSkuPreview.skipped, 1, 'Own job blocks update; foreign stock is irrelevant')

  // Feed terminal events to the historical scheduler; pending/unknown results excluded.
  for (let i = 0; i < 25; i++) {
    const other = Number(
      db.prepare(
        "INSERT INTO vehicles(organization_id,year,make,model,status) VALUES (?,2022,'Toyota',?,'Rascunho')",
      ).run(org, `Teste ${i}`).lastInsertRowid,
    )
    db.prepare(
      `INSERT INTO publication_jobs(organization_id,vehicle_id,status,started_at)
        VALUES (?,?,?,datetime('now','-1 day'))`,
    ).run(org, other, i < 18 ? 'completed' : 'error')
  }
  const history = organizationScheduleHistory(db, org)
  assert.equal(history.reduce((n, h) => n + (h.attemptCount || 0), 0), 25)
  assert.equal(history.reduce((n, h) => n + h.successCount, 0), 18)
  const insights = await admin('/operations/scheduling-insights')
  assert.equal(insights.eligible, true)
  assert.equal(insights.totalSamples, 25)
  assert.equal(insights.totalCompletions, 18)
  assert.equal(insights.completionRate, 72)
  assert(insights.topSlots.length)
  assert.match(insights.metric, /não visualizações/)
  console.log('✓ Phase 5: data-backed schedules, CSV preview/commit, stale guard and live-job safety')
} finally {
  db.close()
  await server.close()
}
