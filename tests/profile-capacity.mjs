import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'
import { profileCapacity, profileLimits } from '../server/services/profile-capacity.ts'
import { calculateOptimalSchedule } from '../server/services/smart-scheduler.ts'
import { findBestAccountForVehicle } from '../server/services/session-manager.ts'

const testServer = await startTestServer()
const db = new DatabaseSync(join(testServer.dataDir, 'autoflow.db'))
try {
  const anonymous = createApiClient(testServer.base, '')
  const login = await anonymous('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: testServer.email, password: testServer.password }),
  })
  const api = createApiClient(testServer.base, login.token)
  const org = db.prepare('SELECT organization_id org,id FROM users WHERE email=?')
    .get(testServer.email)
  const accountId = Number(db.prepare(
    "INSERT INTO social_accounts (organization_id,user_id,label,browser_profile,status) " +
      "VALUES (?,?, 'Testes', 'brave-test', 'connected')",
  ).run(org.org, org.id).lastInsertRowid)
  const path = '/social-accounts/' + accountId + '/capacity'
  const patch = (value) => api(path, { method: 'PATCH', body: JSON.stringify(value) })
  const reject = (promise, status) => assert.rejects(promise, (e) => e.status === status)
  const original = await api(path)
  assert.equal(original.dailyLimit, 10)
  assert.equal(original.intervalMinutes, 25)
  assert.equal(original.dailyLimitOverride, null)
  assert.equal(original.used, 0)
  await reject(anonymous(path), 401)
  await reject(patch({ dailyLimitOverride: 0, intervalMinutesOverride: 20 }), 400)
  await reject(patch({ dailyLimitOverride: 10, intervalMinutesOverride: 1441 }), 400)
  await reject(patch({ dailyLimitOverride: '3', intervalMinutesOverride: 25 }), 400)
  await reject(patch({ dailyLimitOverride: 3 }), 400)
  await reject(api('/social-accounts/999999/capacity'), 404)

  const updated = await patch({ dailyLimitOverride: 2, intervalMinutesOverride: 60 })
  assert.equal(updated.dailyLimit, 2)
  assert.equal(updated.intervalMinutes, 60)
  const updatedLimits = profileLimits(db, org.org, accountId)
  assert.equal(updatedLimits.dailyLimit, 2)
  assert.equal(updatedLimits.intervalMinutes, 60)

  const otherOrg = Number(db.prepare("INSERT INTO organizations(name) VALUES ('Outra empresa')")
    .run().lastInsertRowid)
  const foreignAccount = Number(db.prepare(
    'INSERT INTO social_accounts(organization_id,user_id,label) VALUES (?,?,?)',
  ).run(otherOrg, org.id, 'Isolado').lastInsertRowid)
  await reject(api('/social-accounts/' + foreignAccount + '/capacity'), 404)
  await reject(api('/social-accounts/' + foreignAccount + '/capacity', {
    method: 'PATCH',
    body: JSON.stringify({ dailyLimitOverride: 1, intervalMinutesOverride: 60 }),
  }), 404)

  const vehicle = Number(db.prepare(
    "INSERT INTO vehicles(organization_id,year,make,model,status) VALUES (?,2022,'Toyota','Corolla','Pronto')",
  ).run(org.org).lastInsertRowid)
  const job = Number(db.prepare(
    "INSERT INTO publication_jobs(organization_id,vehicle_id,social_account_id,status) VALUES (?,?,?,'error')",
  ).run(org.org, vehicle, accountId).lastInsertRowid)
  db.prepare(
    "INSERT INTO publication_job_events(organization_id,publication_job_id,event_type,details) " +
    "VALUES (?,?, 'filling_started', ?)",
  ).run(org.org, job, JSON.stringify({ accountId }))
  let capacity = profileCapacity(db, org.org, accountId)
  assert.equal(capacity.used, 1)
  assert.equal(capacity.remaining, 1)
  assert(capacity.retryAfterSeconds > 0)
  assert(capacity.nextAllowedAt)
  const fallback = await patch({
    dailyLimitOverride: null, intervalMinutesOverride: null,
  })
  assert.equal(fallback.dailyLimit, 10)
  assert.equal(fallback.intervalMinutes, 25)

  await patch({ dailyLimitOverride: 1, intervalMinutesOverride: 45 })
  capacity = profileCapacity(db, org.org, accountId)
  assert.equal(capacity.blockedByDailyLimit, true)
  assert.equal(capacity.remaining, 0)
  assert.equal(findBestAccountForVehicle(db, org.org, vehicle), null)

  const now = new Date('2026-10-13T10:00:00Z')
  const occupancy = Date.parse('2026-10-13T13:00:00Z')
  const schedule = calculateOptimalSchedule({
    referenceDate: now,
    existingTimestamps: [occupancy],
    spacingMinutes: 90,
    minDelayMinutes: 10,
  })
  assert(Number.isFinite(schedule.scheduledAt.getTime()))
  assert(Math.abs(schedule.scheduledAt.getTime() - occupancy) >= 90 * 60000)

  console.log('✓ Profile capacity: tenant isolation, overrides, actual attempts, claim spacing and inherited limits')
} finally {
  db.close()
  await testServer.close()
}
