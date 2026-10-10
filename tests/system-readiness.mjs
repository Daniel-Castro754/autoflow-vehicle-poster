import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'
import { systemReadiness } from '../server/services/system-readiness.ts'

const server = await startTestServer()
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
try {
  const anonymous = createApiClient(server.base, '')
  async function login(email) {
    const result = await anonymous('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: server.password }),
    })
    return createApiClient(server.base, result.token)
  }
  const primary = db
    .prepare('SELECT organization_id org,password_hash hash FROM users WHERE email=?')
    .get(server.email)
  const org = primary.org
  const foreign = Number(
    db.prepare("INSERT INTO organizations(name) VALUES('External Tenant')").run().lastInsertRowid,
  )
  db.prepare('INSERT INTO organization_settings(organization_id) VALUES(?)').run(foreign)
  db.prepare(
    'INSERT INTO users(organization_id,name,email,password_hash,role) VALUES(?,?,?,?,?)',
  ).run(org, 'Vendedor', 'readiness-seller@test.local', primary.hash, 'seller')
  db.prepare(
    'INSERT INTO users(organization_id,name,email,password_hash,role) VALUES(?,?,?,?,?)',
  ).run(foreign, 'Other Admin', 'readiness-other@test.local', primary.hash, 'admin')
  const admin = await login(server.email)
  const seller = await login('readiness-seller@test.local')
  const other = await login('readiness-other@test.local')
  await assert.rejects(anonymous('/health/readiness'), (error) => error.status === 401)
  await assert.rejects(seller('/health/readiness'), (error) => error.status === 403)

  // Internal database secrets and other organizations must NEVER escape.
  const passwordLikeWebhook = 'https://hooks.example.org/very-sensitive-test-value'
  const fakeGeminiKey = 'fake-gemini-readiness-key-must-not-escape'
  db.prepare(
    'UPDATE organization_settings SET gemini_api_key=?, alert_webhook_url=?,autopilot_enabled=1,fill_groups=1 WHERE organization_id=?',
  ).run(fakeGeminiKey, passwordLikeWebhook, org)
  db.prepare(
    'INSERT INTO marketplace_groups (organization_id,name,url,active) VALUES (?,?,?,1)',
  ).run(foreign, 'Private tenant group', 'https://facebook.com/groups/private-tenant')
  db.prepare('UPDATE organization_settings SET autopilot_enabled=1 WHERE organization_id=?').run(
    foreign,
  )
  let report = await admin('/health/readiness?organizationId=' + foreign)
  assert(report.checks.some((item) => item.id === 'vault' && item.status === 'attention'))
  assert(report.checks.some((item) => item.id === 'groups' && item.status === 'attention'))
  assert(report.guides.some((item) => item.checkId === 'groups' && item.performsChanges === false))
  assert(
    report.guides.some((item) => item.checkId === 'backup' && item.priority === 'verification'),
  )
  assert(report.guides.every((guide) => guide.requiresHumanApproval && guide.steps.length >= 3))
  assert(report.checks.some((item) => item.id === 'webhook' && item.status === 'ok'))
  assert.equal(report.automation.activeGroups, 0)
  assert.equal(report.automation.enabled, true)
  assert.equal(
    report.summary.attention,
    report.checks.filter((x) => x.status === 'attention').length,
  )
  assert(!JSON.stringify(report).includes(passwordLikeWebhook))
  assert(report.guides.every((guide) => !('token' in guide) && !('apiKey' in guide)))
  assert(!JSON.stringify(report).includes(fakeGeminiKey))
  assert(!JSON.stringify(report).includes('Private tenant group'))
  assert(!JSON.stringify(report).includes('private-tenant'))

  // A diagnostic GET should not record a preview, change group membership, or create jobs.
  const counts = () => ({
    jobs: db.prepare('SELECT COUNT(*) n FROM publication_jobs WHERE organization_id=?').get(org).n,
    groups: db.prepare('SELECT COUNT(*) n FROM marketplace_groups WHERE organization_id=?').get(org)
      .n,
    aiHistory: db
      .prepare('SELECT COUNT(*) n FROM ai_operation_history WHERE organization_id=?')
      .get(org).n,
  })
  const before = counts()
  for (let i = 0; i < 3; i++) report = await admin('/health/readiness')
  assert.deepEqual(counts(), before)
  assert(report.evidence.includes('não testa redes'))
  assert(report.checks.every((item) => !('secret' in item) && !('key' in item)))
  assert.deepEqual(
    report.checks.map((item) => item.id).sort(),
    [...new Set(report.checks.map((item) => item.id))].sort(),
  )

  const otherReport = await other('/health/readiness')
  assert.equal(otherReport.automation.activeGroups, 1)
  assert(!otherReport.guides.some((guide) => guide.checkId === 'groups'))
  assert((await admin('/health/readiness')).guides.some((guide) => guide.checkId === 'groups'))
  assert.equal(otherReport.automation.enabled, true)
  assert.equal((await admin('/health/readiness')).automation.activeGroups, 0)
  assert(!JSON.stringify(otherReport).includes(passwordLikeWebhook))
  const source = systemReadiness(db, org)
  assert.equal(source.automation.basicCandidates, report.automation.basicCandidates)
  console.log(
    '✓ Read-only diagnostics: authorization, tenant isolation, no secret leakage and no mutations',
  )
} finally {
  db.close()
  await server.close()
}
