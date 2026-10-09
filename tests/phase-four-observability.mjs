import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'
import { recordOperationalSignal } from '../server/services/operational-incidents.ts'

const server = await startTestServer()
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
const anon = createApiClient(server.base, '')
const denies = (request, status) => assert.rejects(request, (error) => error.status === status)
const login = async (email) => {
  const response = await anon('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: server.password }),
  })
  return createApiClient(server.base, response.token)
}
const insertVehicle = (organizationId, n) =>
  Number(
    db
      .prepare(
        "INSERT INTO vehicles(organization_id,year,make,model,status) VALUES (?,2022,'Toyota',?,'Pronto')",
      )
      .run(organizationId, `Modelo ${n}`).lastInsertRowid,
  )
const insertJob = (organizationId, vehicleId, status) =>
  Number(
    db
      .prepare('INSERT INTO publication_jobs (organization_id,vehicle_id,status) VALUES (?,?,?)')
      .run(organizationId, vehicleId, status).lastInsertRowid,
  )

try {
  const primary = db
    .prepare(
      'SELECT id,organization_id organizationId,password_hash passwordHash FROM users WHERE email=?',
    )
    .get(server.email)
  const orgId = primary.organizationId
  const otherOrgId = Number(
    db.prepare("INSERT INTO organizations(name) VALUES ('Outra organização')").run()
      .lastInsertRowid,
  )
  db.prepare(
    "INSERT INTO users(organization_id,name,email,password_hash,role) VALUES (?,?,?,?, 'admin')",
  ).run(otherOrgId, 'Admin externo', 'foreign@test.local', primary.passwordHash)
  db.prepare(
    "INSERT INTO users(organization_id,name,email,password_hash,role) VALUES (?,?,?,?, 'seller')",
  ).run(orgId, 'Vendedor', 'seller@test.local', primary.passwordHash)

  const admin = await login(server.email)
  const external = await login('foreign@test.local')
  const seller = await login('seller@test.local')
  await denies(() => anon('/operations/incidents'), 401)
  const jobId = insertJob(orgId, insertVehicle(orgId, 1), 'error')
  const otherJobId = insertJob(otherOrgId, insertVehicle(otherOrgId, 2), 'error')
  recordOperationalSignal(db, orgId, jobId, 'fill_error', { error: 'Erro transitório sem retry' })
  recordOperationalSignal(db, orgId, jobId, 'fill_error', { error: 'Falha repetida' })
  recordOperationalSignal(db, otherOrgId, otherJobId, 'fill_error')
  let list = await admin('/operations/incidents')
  assert.equal(list.incidents.length, 1)
  assert.equal(list.incidents[0].occurrenceCount, 2, 'Repeated errors must deduplicate')
  assert.equal(list.totals.open, 1)
  assert.equal((await external('/operations/incidents')).incidents[0].jobId, otherJobId)
  assert.equal((await seller('/operations/incidents')).incidents.length, 1)

  const incidentId = list.incidents[0].id
  await denies(() => external(`/operations/incidents/${incidentId}/history`), 404)
  await denies(
    () =>
      external(`/operations/incidents/${incidentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'acknowledge' }),
      }),
    404,
  )
  await denies(
    () =>
      seller(`/operations/incidents/${incidentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'acknowledge' }),
      }),
    403,
  )
  await denies(
    () =>
      admin(`/operations/incidents/${incidentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'nonsense' }),
      }),
    400,
  )
  const acknowledged = await admin(`/operations/incidents/${incidentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'acknowledge', note: 'Equipe avisada' }),
  })
  assert.equal(acknowledged.status, 'acknowledged')
  const repeat = await admin(`/operations/incidents/${incidentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'acknowledge' }),
  })
  assert.equal(repeat.idempotent, true)
  assert.equal((await admin('/operations/incidents')).totals.acknowledged, 1)
  assert.equal(
    (await admin(`/operations/incidents/${incidentId}/history`)).history.filter(
      (h) => h.action === 'acknowledged',
    ).length,
    1,
  )

  // A possible Facebook publish must not be dismissed as a UI-only alert.
  const uncertainJob = insertJob(orgId, insertVehicle(orgId, 3), 'awaiting_confirmation')
  recordOperationalSignal(db, orgId, uncertainJob, 'publish_result_unknown')
  list = await admin('/operations/incidents')
  const uncertain = list.incidents.find((i) => i.jobId === uncertainJob)
  assert.equal(uncertain.severity, 'critical')
  await denies(
    () =>
      admin(`/operations/incidents/${uncertain.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'resolve' }),
      }),
    409,
  )
  await admin(`/operations/incidents/${uncertain.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'acknowledge' }),
  })
  assert.equal(
    db.prepare('SELECT status FROM publication_jobs WHERE id=?').get(uncertainJob).status,
    'awaiting_confirmation',
  )
  db.prepare("UPDATE publication_jobs SET status='completed' WHERE id=?").run(uncertainJob)
  recordOperationalSignal(db, orgId, uncertainJob, 'confirmed_published')
  assert.equal(
    db.prepare('SELECT status FROM operational_incidents WHERE id=?').get(uncertain.id).status,
    'resolved',
  )
  assert.equal(
    (await admin(`/operations/incidents/${uncertain.id}/history`)).history[0].action,
    'auto_resolved',
  )

  const resolved = await admin(`/operations/incidents/${incidentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'resolve' }),
  })
  assert.equal(resolved.status, 'resolved')
  recordOperationalSignal(db, orgId, jobId, 'fill_error', { error: 'Voltou a ocorrer' })
  assert.equal(
    db
      .prepare('SELECT status,occurrence_count count FROM operational_incidents WHERE id=?')
      .get(incidentId).status,
    'open',
  )
  assert.equal(
    (await admin(`/operations/incidents/${incidentId}/history`)).history[0].action,
    'reopened',
  )

  const slowJob = insertJob(orgId, insertVehicle(orgId, 4), 'filling')
  recordOperationalSignal(db, orgId, slowJob, 'job_nearly_stuck')
  recordOperationalSignal(db, orgId, slowJob, 'stalled_recovered')
  const slow = db
    .prepare(
      "SELECT status FROM operational_incidents WHERE organization_id=? AND publication_job_id=? AND kind='slow_execution'",
    )
    .get(orgId, slowJob)
  assert.equal(slow.status, 'resolved')

  db.prepare(
    "INSERT INTO publication_job_events(organization_id,publication_job_id,event_type) VALUES (?,?, 'filling_started')",
  ).run(orgId, jobId)
  db.prepare(
    "INSERT INTO publication_job_events(organization_id,publication_job_id,event_type) VALUES (?,?, 'filling_started')",
  ).run(otherOrgId, otherJobId)
  const activity = await admin('/operations/activity?limit=50')
  assert(activity.activity.some((e) => e.jobId === jobId))
  assert(!activity.activity.some((e) => e.jobId === otherJobId))
  await denies(() => admin('/operations/activity?beforeId=garbage'), 400)
  await denies(() => admin('/operations/incidents?status=garbage'), 400)
  assert.equal(
    (await admin(`/operations/activity?jobId=${jobId}`)).activity.every((e) => e.jobId === jobId),
    true,
  )
  console.log(
    '✓ Phase 4: persistent incidents, dedup/reopen, RBAC, isolation, audit and publish safety',
  )
} finally {
  db.close()
  await server.close()
}
