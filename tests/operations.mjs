import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { coordinateAutopilot, skippedAutopilot } from '../server/services/autopilot-coordinator.ts'
import { createAutonomousScheduler } from '../server/services/autonomous-scheduler.ts'
import { runAutopilotPipeline } from '../server/services/ai-agent.ts'
import { operationalHealth } from '../server/services/operational-health.ts'
import { warnSlowExecutions } from '../server/services/proactive-alerts.ts'
import {
  withRequestContext,
  currentRequestId,
  requestIdFor,
} from '../server/lib/request-context.ts'
import { logger } from '../server/lib/logger.ts'
import { startTestServer, createApiClient } from './helpers/server.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const dir = await mkdtemp(join(tmpdir(), 'autoflow-operations-'))
const db = new DatabaseSync(join(dir, 'test.db'))
initializeBaseSchema(db)
applyMigrations(db)
const other = new DatabaseSync(join(dir, 'test.db'))
initializeBaseSchema(other)
applyMigrations(other)

function seedOrg(id, enabled = 1) {
  db.prepare('INSERT INTO organizations(id,name) VALUES (?,?)').run(id, `Org ${id}`)
  db.prepare(
    "INSERT INTO users(id,organization_id,name,email,password_hash,role) VALUES(?,?,?,?,'fixture','admin')",
  ).run(id, id, `Admin ${id}`, `${id}@test.local`)
  db.prepare(
    'INSERT INTO organization_settings(organization_id,autopilot_enabled,daily_limit,auto_publish,auto_advance,stuck_timeout_minutes) VALUES(?,?,2,1,1,15)',
  ).run(id, enabled)
  db.prepare(
    "INSERT INTO social_accounts(id,organization_id,user_id,label,status) VALUES(?,?,?,?,'connected')",
  ).run(id, id, id, `Account ${id}`)
}
function vehicle(
  id,
  org,
  description = 'Descrição de veículo completa e suficiente para publicação com todos os dados necessários.',
) {
  db.prepare(
    `INSERT INTO vehicles(id,organization_id,year,make,model,price,km,status,location,description,exterior_color,interior_color,vehicle_condition)
    VALUES(?,?,2023,'Toyota',?,90000,100,'Pronto','São Paulo, SP',?,'Prateado','Preto','Excelente')`,
  ).run(id, org, `Corolla ${id}`, description)
  db.prepare(
    "INSERT INTO vehicle_images(organization_id,vehicle_id,file_name,original_name,mime_type,content_hash) VALUES(?,?,?,?,'image/jpeg',?)",
  ).run(org, id, `${id}.jpg`, `${id}.jpg`, `unique-${id}`)
}

try {
  seedOrg(1)
  seedOrg(2, 0)
  seedOrg(3)
  for (let id = 1; id <= 5; id++) vehicle(id, 1)
  vehicle(20, 2)
  vehicle(30, 3)
  db.exec(
    "INSERT INTO social_accounts(id,organization_id,user_id,label,status) VALUES(10,1,1,'Second account','connected')",
  )
  const started = deferred(),
    finish = deferred()
  const manual = coordinateAutopilot(db, 1, false, async (ownsLease) => {
    assert(ownsLease())
    started.resolve()
    await finish.promise
    assert(ownsLease())
    return skippedAutopilot('test')
  })
  await started.promise
  assert.equal(
    (await runAutopilotPipeline(other, 1, null, { automatic: true })).jobsCreated,
    0,
    'A second DB connection must not steal a live manual lease',
  )
  assert.equal(
    (await runAutopilotPipeline(other, 3, null, { automatic: true })).jobsCreated,
    1,
    'Another organization is independent',
  )
  finish.resolve()
  await manual
  db.exec('UPDATE autopilot_state SET next_run_at=NULL WHERE organization_id=1')
  const worker = createAutonomousScheduler(db)
  await worker.sweep()
  assert.deepEqual(
    db
      .prepare(
        'SELECT social_account_id account,COUNT(*) n FROM publication_jobs WHERE organization_id=1 GROUP BY social_account_id ORDER BY social_account_id',
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { account: 1, n: 2 },
      { account: 10, n: 2 },
    ],
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM publication_jobs WHERE organization_id=2').get().n,
    0,
  )
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM publication_job_events WHERE organization_id=1 AND created_by IS NULL AND json_extract(details,'$.trigger')='recurring'",
      )
      .get().n,
    4,
  )
  const state = { ...db.prepare('SELECT * FROM autopilot_state WHERE organization_id=1').get() }
  await worker.sweep()
  assert.deepEqual(
    { ...db.prepare('SELECT * FROM autopilot_state WHERE organization_id=1').get() },
    state,
    'A sweep before next_run_at must do nothing',
  )
  worker.stop()
  assert.equal(
    db.prepare('SELECT auto_publish FROM organization_settings WHERE organization_id=1').get()
      .auto_publish,
    1,
  )
  await assert.rejects(
    coordinateAutopilot(db, 1, false, async () => {
      throw new Error('fixture failure')
    }),
    /fixture failure/,
  )
  assert.equal(
    db.prepare('SELECT last_status FROM autopilot_state WHERE organization_id=1').get().last_status,
    'error',
  )
  assert.equal(
    db.prepare('SELECT lease_owner FROM autopilot_state WHERE organization_id=1').get().lease_owner,
    null,
  )

  db.exec('UPDATE autopilot_state SET next_run_at=NULL')
  const called = [],
    release = deferred(),
    entered = deferred()
  const guardedWorker = createAutonomousScheduler(db, {
    run: async (_db, id) => {
      called.push(id)
      if (id === 1) {
        entered.resolve()
        await release.promise
        throw new Error('expected organization failure')
      }
      return skippedAutopilot('test')
    },
  })
  const sweep = guardedWorker.sweep()
  await entered.promise
  await guardedWorker.sweep()
  assert.deepEqual(called, [1], 'Timer ticks cannot overlap a running sweep')
  release.resolve()
  await sweep
  assert.deepEqual(called, [1, 3], 'A failure in one organization cannot stop the next')
  guardedWorker.stop()
  await guardedWorker.sweep()
  assert.deepEqual(called, [1, 3])

  seedOrg(4)
  vehicle(40, 4, '')
  const selling = runAutopilotPipeline(db, 4, null, { automatic: true })
  db.exec("UPDATE vehicles SET status='Vendido',sold_at=CURRENT_TIMESTAMP WHERE id=40")
  assert.equal(
    (await selling).jobsCreated,
    0,
    'A sale during description generation must prevent scheduling',
  )
  seedOrg(5)
  vehicle(50, 5, '')
  const disabling = runAutopilotPipeline(db, 5, null, { automatic: true })
  db.exec('UPDATE organization_settings SET autopilot_enabled=0 WHERE organization_id=5')
  assert.equal(
    (await disabling).jobsCreated,
    0,
    'Disabling recurring planning must stop pending inserts',
  )
  assert.equal(
    (await runAutopilotPipeline(db, 5, 5)).jobsCreated,
    1,
    'Manual planning remains available with recurrence off',
  )
  seedOrg(6)
  vehicle(60, 6, '')
  const lostLease = runAutopilotPipeline(db, 6, null, { automatic: true })
  db.exec("UPDATE autopilot_state SET lease_owner='replacement' WHERE organization_id=6")
  assert.equal((await lostLease).jobsCreated, 0)
  assert.equal(
    db.prepare('SELECT lease_owner FROM autopilot_state WHERE organization_id=6').get().lease_owner,
    'replacement',
    'An old owner must not clear the replacement lease',
  )
  db.exec(
    "UPDATE autopilot_state SET lease_expires_at=datetime('now','-1 minute'),next_run_at=NULL WHERE organization_id=6",
  )
  assert.equal(
    (await runAutopilotPipeline(other, 6, null, { automatic: true })).jobsCreated,
    1,
    'A crashed/expired planner can be replaced',
  )
  seedOrg(7)
  vehicle(70, 7, '')
  const editing = runAutopilotPipeline(db, 7, null, { automatic: true })
  db.exec('UPDATE vehicles SET price=125000 WHERE id=70')
  assert.equal(
    (await editing).jobsCreated,
    0,
    'Stale generated descriptions cannot overwrite changed stock',
  )

  seedOrg(8)
  db.exec('UPDATE organization_settings SET daily_limit=50 WHERE organization_id=8')
  for (let id = 800; id < 821; id++) vehicle(id, 8)
  assert.equal((await runAutopilotPipeline(db, 8, null, { automatic: true })).jobsCreated, 20)
  db.exec('UPDATE autopilot_state SET next_run_at=NULL WHERE organization_id=8')
  assert.equal(
    (await runAutopilotPipeline(db, 8, null, { automatic: true })).jobsCreated,
    1,
    'The batch limit must leave remaining stock for the next round',
  )

  const accountJobs = db
    .prepare(
      'SELECT id FROM publication_jobs WHERE organization_id=1 AND social_account_id=1 ORDER BY id',
    )
    .all()
  db.prepare(
    "UPDATE publication_jobs SET status='completed',started_at=datetime('now','-65 minutes'),filled_at=datetime('now','-60 minutes') WHERE id=?",
  ).run(accountJobs[0].id)
  db.prepare(
    "UPDATE publication_jobs SET status='error',updated_at=CURRENT_TIMESTAMP WHERE id=?",
  ).run(accountJobs[1].id)
  const performanceReport = operationalHealth(db, 1)
  assert.deepEqual(
    { ...performanceReport.performance },
    {
      completed: 1,
      errors: 1,
      averageDurationSeconds: 300,
    },
  )
  assert.equal(performanceReport.accounts.find((account) => account.id === 1).successRate, 0.5)
  assert.equal(operationalHealth(db, 3).performance.averageDurationSeconds, null)
  db.exec(
    "UPDATE publication_jobs SET status='pending',started_at=NULL,filled_at=NULL WHERE organization_id=1",
  )

  const job = db
    .prepare('SELECT id FROM publication_jobs WHERE organization_id=1 ORDER BY id LIMIT 1')
    .get().id
  db.prepare(
    "UPDATE publication_jobs SET status='filling',started_at=datetime('now','-12 minutes'),lease_expires_at=datetime('now','+1 minute'),attempt_count=3 WHERE id=?",
  ).run(job)
  db.exec(
    "UPDATE organization_settings SET alert_telegram_token='org-one-token',alert_telegram_chat_id='org-one-chat' WHERE organization_id=1",
  )
  const deliveries = []
  const send = async (alert, config) => {
    deliveries.push({ alert, config })
    return { telegram: false, webhook: false }
  }
  assert.equal(operationalHealth(db, 1).slowJobsCount, 1)
  assert.equal(operationalHealth(db, 2).slowJobsCount, 0)
  assert.equal(operationalHealth(db, 1).warningCount, 0, 'A read must not send or record warnings')
  await Promise.all([warnSlowExecutions(db, send), warnSlowExecutions(other, send)])
  assert.equal(
    deliveries.length,
    1,
    'Deduplication must survive another connection and failed delivery',
  )
  assert.equal(deliveries[0].config.telegramBotToken, 'org-one-token')
  assert.equal(deliveries[0].alert.severity, 'warning')
  assert.equal(
    db.prepare('SELECT status FROM publication_jobs WHERE id=?').get(job).status,
    'filling',
  )
  assert.equal(operationalHealth(db, 1).warningCount, 1)
  db.prepare('UPDATE publication_jobs SET attempt_count=4 WHERE id=?').run(job)
  await warnSlowExecutions(other, send)
  assert.equal(deliveries.length, 2, 'A new execution can generate its own warning')
  db.prepare(
    "UPDATE publication_jobs SET attempt_count=5,lease_expires_at=datetime('now','-1 minute') WHERE id=?",
  ).run(job)
  await warnSlowExecutions(db, send)
  assert.equal(deliveries.length, 2, 'Expired jobs belong to recovery, not early warning')
} finally {
  other.close()
  db.close()
  await rm(dir, { recursive: true, force: true })
}

const lines = [],
  originalInfo = console.info
console.info = (line) => lines.push(JSON.parse(line))
try {
  await Promise.all(
    ['request-one', 'request-two'].map((id) =>
      withRequestContext(id, async () => {
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(currentRequestId(), id)
        logger.info('fixture', 'Concurrent request', { token: 'never-log-this' })
      }),
    ),
  )
} finally {
  console.info = originalInfo
}
assert.deepEqual(lines.map((line) => line.requestId).sort(), ['request-one', 'request-two'])
assert(lines.every((line) => line.details.token === '[REDACTED]'))
assert.equal(currentRequestId(), undefined)
assert.equal(requestIdFor('safe-id:12'), 'safe-id:12')
assert.match(requestIdFor('bad\nvalue'), /^[a-f0-9-]{36}$/)
assert.match(requestIdFor('x'.repeat(100)), /^[a-f0-9-]{36}$/)

const server = await startTestServer()
const sql = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
try {
  for (const path of ['/health/detailed', '/metrics'])
    assert.equal((await fetch(server.base + path)).status, 401)
  assert.equal((await fetch(server.base + '/health')).status, 200)
  const anonymous = createApiClient(server.base, '')
  const login = await anonymous('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const client = createApiClient(server.base, login.token)
  const user = (await client('/me')).user
  sql.prepare("INSERT INTO organizations(id,name) VALUES(99,'Other tenant')").run()
  sql.exec(`INSERT INTO organization_settings(organization_id) VALUES(99);
    INSERT INTO users(organization_id,name,email,password_hash,role) SELECT 99,'Other','other@test.local',password_hash,'admin' FROM users LIMIT 1;
    INSERT INTO vehicles(id,organization_id,year,make,model,status) VALUES(990,99,2023,'Toyota','Secret model','Pronto');
    INSERT INTO publication_jobs(organization_id,vehicle_id,status) VALUES(99,990,'error'),(99,990,'error');`)
  const vehicle = sql
    .prepare('SELECT id FROM vehicles WHERE organization_id=? LIMIT 1')
    .get(user.organizationId)
  sql
    .prepare(
      "INSERT INTO publication_jobs(organization_id,vehicle_id,status) VALUES(?,?,'pending')",
    )
    .run(user.organizationId, vehicle.id)
  const report = await client('/health/detailed?organizationId=99')
  assert.equal(report.jobs.total, 1)
  assert.equal(report.jobs.pending, 1)
  assert.equal(report.recentErrorsCount, 0)
  const secondLogin = await anonymous('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'other@test.local', password: server.password }),
  })
  const secondClient = createApiClient(server.base, secondLogin.token)
  assert.equal((await secondClient('/health/detailed')).recentErrorsCount, 2)
  const metric = await fetch(server.base + '/metrics', {
    headers: { Authorization: `Bearer ${login.token}`, 'X-Request-Id': 'metrics-fixture' },
  })
  assert.equal(metric.status, 200)
  assert.match(metric.headers.get('content-type'), /text\/plain/)
  assert.equal(metric.headers.get('cache-control'), 'no-store')
  assert.equal(metric.headers.get('x-request-id'), 'metrics-fixture')
  const metricText = await metric.text()
  assert.match(metricText, /autoflow_jobs 1\n/)
  assert.match(metricText, /autoflow_jobs_error_24h 0\n/)
  assert(!metricText.includes('Secret'))

  const accountId = Number(
    sql
      .prepare(
        "INSERT INTO social_accounts(organization_id,user_id,label,status,browser_profile) VALUES(?,?,?,'connected',?)",
      )
      .run(user.organizationId, user.id, 'Batch retry profile', 'Profile batch').lastInsertRowid,
  )
  const errorJobIds = ['first', 'second'].map(() =>
    Number(
      sql
        .prepare(
          "INSERT INTO publication_jobs(organization_id,vehicle_id,social_account_id,status,error_code) VALUES(?,?,?,'error','fixture')",
        )
        .run(user.organizationId, vehicle.id, accountId).lastInsertRowid,
    ),
  )
  const retried = await client('/publications/reprocess-batch', {
    method: 'PATCH',
    body: JSON.stringify({ ids: errorJobIds }),
  })
  assert.equal(retried.updated, 2)
  assert.deepEqual(
    sql
      .prepare(
        `SELECT id,status,error_code errorCode FROM publication_jobs WHERE id IN (${errorJobIds
          .map(() => '?')
          .join(',')}) ORDER BY id`,
      )
      .all(...errorJobIds),
    errorJobIds.map((id) => ({ id, status: 'pending', errorCode: null })),
  )

  sql
    .prepare(
      "UPDATE social_accounts SET automation_paused=1,automation_pause_reason='selector drift' WHERE id=?",
    )
    .run(accountId)
  const blockedJobId = Number(
    sql
      .prepare(
        "INSERT INTO publication_jobs(organization_id,vehicle_id,social_account_id,status,error_code) VALUES(?,?,?,'error','fixture')",
      )
      .run(user.organizationId, vehicle.id, accountId).lastInsertRowid,
  )
  await assert.rejects(
    () =>
      client('/publications/reprocess-batch', {
        method: 'PATCH',
        body: JSON.stringify({ ids: [blockedJobId] }),
      }),
    (error) => error.status === 423,
  )
  assert.equal(
    sql.prepare('SELECT status FROM publication_jobs WHERE id=?').get(blockedJobId).status,
    'error',
  )
  sql.prepare('UPDATE social_accounts SET automation_paused=0 WHERE id=?').run(accountId)
  const requests = await Promise.all(
    ['first', 'second'].map((id) =>
      fetch(server.base + '/health', { headers: { 'X-Request-Id': id } }),
    ),
  )
  assert.deepEqual(
    requests.map((response) => response.headers.get('x-request-id')),
    ['first', 'second'],
  )
  const cors = await fetch(server.base + '/health', {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Headers': 'X-Request-Id' },
  })
  assert.equal(cors.status, 204)
  assert.match(cors.headers.get('access-control-allow-headers'), /X-Request-Id/)

  sql
    .prepare(
      'UPDATE organization_settings SET execution_interval_minutes=47 WHERE organization_id=?',
    )
    .run(user.organizationId)
  const settingsBody = {
    organizationName: 'Audit organization',
    autoAdvance: true,
    autoPublish: true,
    autopilotEnabled: true,
    autopilotIntervalMinutes: 7,
  }
  await client('/settings', { method: 'PATCH', body: JSON.stringify(settingsBody) })
  let settings = (await client('/settings')).settings
  assert.equal(
    settings.executionIntervalMinutes,
    47,
    'Changing recurrence must preserve publication pacing',
  )
  assert.equal(settings.autopilotEnabled, 1)
  assert.equal(settings.autopilotIntervalMinutes, 7)
  assert.equal(settings.autoPublish, 1)
  await client('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      organizationName: 'Legacy client',
      autoAdvance: true,
      autoPublish: true,
    }),
  })
  settings = (await client('/settings')).settings
  assert.equal(settings.autopilotEnabled, 1)
  assert.equal(settings.autopilotIntervalMinutes, 7)
  for (const value of [0, 1.5, 1441, '5', null])
    await assert.rejects(
      () =>
        client('/settings', {
          method: 'PATCH',
          body: JSON.stringify({ ...settingsBody, autopilotIntervalMinutes: value }),
        }),
      (error) => error.status === 400,
    )
  await client('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ ...settingsBody, autopilotEnabled: false }),
  })
  settings = (await client('/settings')).settings
  assert.equal(settings.autopilotEnabled, 0)
  assert.equal(settings.autoPublish, 1)
  await client('/auth/logout', { method: 'POST' })
  for (const path of ['/health/detailed', '/metrics'])
    assert.equal(
      (await fetch(server.base + path, { headers: { Authorization: `Bearer ${login.token}` } }))
        .status,
      401,
    )
} finally {
  sql.close()
  await server.close()
}
console.log(
  '✓ Isolamento de saúde/métricas, sessões, concorrência entre processos, cadência, venda/edição, logs e alertas por execução.',
)
