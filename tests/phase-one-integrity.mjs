import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { runHealthCheck } from '../server/services/health-monitor.ts'
import { jpegBase64 } from './helpers/images.mjs'
import { startTestServer, createApiClient } from './helpers/server.mjs'

// DB-level uniqueness must survive concurrent application writers.
const isolated = new DatabaseSync(':memory:')
try {
  initializeBaseSchema(isolated)
  applyMigrations(isolated)
  isolated.exec(`
    INSERT INTO organizations(id,name) VALUES (1,'Test');
    INSERT INTO users(id,organization_id,name,email,password_hash) VALUES (1,1,'Test','test@example.local','fixture');
    INSERT INTO vehicles(id,organization_id,year,make,model) VALUES (1,1,2022,'Toyota','Corolla');
  `)
  const create = (status) =>
    isolated
      .prepare('INSERT INTO publication_jobs(organization_id,vehicle_id,status) VALUES(1,1,?)')
      .run(status)
  create('pending')
  assert.throws(() => create('error'), /UNIQUE constraint failed/)
  isolated.exec("UPDATE publication_jobs SET status='removed'")
  create('completed')
  assert.throws(() => create('pending'), /UNIQUE constraint failed/)
  isolated.exec("UPDATE publication_jobs SET status='removed'")
  create('pending')
  assert.equal(isolated.prepare('SELECT COUNT(*) n FROM publication_jobs').get().n, 3)
} finally {
  isolated.close()
}

const server = await startTestServer()
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
initializeBaseSchema(db)
try {
  const anonymous = createApiClient(server.base, '')
  const login = await anonymous('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const api = createApiClient(server.base, login.token)
  const userId = (await api('/team')).users[0].id
  const account = await api('/social-accounts', {
    method: 'POST',
    body: JSON.stringify({ userId, label: 'Fase 1', browserProfile: 'Profile 1' }),
  })
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      organizationName: 'Integrity Test',
      dailyLimit: 10,
      executionIntervalMinutes: 0,
    }),
  })

  async function readyVehicle(n) {
    const vehicle = await api('/vehicles', {
      method: 'POST',
      body: JSON.stringify({
        year: 2023,
        make: 'Toyota',
        model: `Corolla ${n}`,
        trim: 'XEi',
        price: 119900,
        km: 42000,
        status: 'Pronto',
        vehicleType: 'Carro/picape',
        location: 'São Paulo, SP',
        transmission: 'Automático',
        fuelType: 'Flex',
        bodyType: 'Sedã',
        condition: 'Excelente',
        exteriorColor: 'Prateado',
        interiorColor: 'Preto',
        description: `Veículo de teste para integridade ${n}.`,
      }),
    })
    await api(`/vehicles/${vehicle.id}/images`, {
      method: 'POST',
      body: JSON.stringify({
        name: `integrity-${n}.jpg`,
        mimeType: 'image/jpeg',
        dataBase64: jpegBase64(`phase1-${n}`),
      }),
    })
    return vehicle.id
  }

  const vehicleA = await readyVehicle(1)
  const vehicleB = await readyVehicle(2)
  const createJob = (vehicleId) =>
    api('/publications', {
      method: 'POST',
      body: JSON.stringify({ vehicleId, accountId: account.id }),
    })
  const firstJob = await createJob(vehicleA)
  const secondJob = await createJob(vehicleB)

  // Duplicate writes are blocked at the DB layer, including across API clients.
  const orgId = db.prepare('SELECT organization_id id FROM vehicles WHERE id=?').get(vehicleA).id
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO publication_jobs(organization_id,vehicle_id,social_account_id,status) VALUES(?,?,?,'pending')",
        )
        .run(orgId, vehicleA, account.id),
    /UNIQUE constraint failed/,
  )

  // Both jobs were created today. A daily limit of one must still allow the FIRST claim.
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      organizationName: 'Integrity Test',
      dailyLimit: 1,
      executionIntervalMinutes: 0,
    }),
  })
  const prepared = await api(`/extension/jobs/${firstJob.id}/prepare`, {
    method: 'POST',
    body: JSON.stringify({ accountId: account.id, instanceId: 'phase_one_instance_alpha' }),
  })
  assert(prepared.leaseToken)
  await api(`/extension/jobs/${firstJob.id}/fill-result`, {
    method: 'PATCH',
    body: JSON.stringify({ leaseToken: prepared.leaseToken, error: 'Falha de teste' }),
  })
  await assert.rejects(
    api(`/extension/jobs/${secondJob.id}/prepare`, {
      method: 'POST',
      body: JSON.stringify({ accountId: account.id, instanceId: 'phase_one_instance_beta' }),
    }),
    (error) => error.status === 409 && error.body?.capacity?.used === 1,
  )
  const claims = db
    .prepare(
      "SELECT COUNT(*) n FROM publication_job_events WHERE organization_id=? AND event_type='filling_started'",
    )
    .get(orgId).n
  assert.equal(claims, 1, 'A successful claim must have exactly one durable event')

  // Interleave a stale monitor read with a different worker renewing ownership.
  db.prepare(
    "UPDATE publication_jobs SET status='filling',started_at=datetime('now','-40 minutes'),lease_token='old-token',lease_owner='old-worker',lease_expires_at=datetime('now','-1 minute') WHERE id=?",
  ).run(firstJob.id)
  const other = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
  try {
    let interleaved = false
    const monitorDb = {
      prepare(sql) {
        if (
          !interleaved &&
          String(sql).includes('SELECT id, organization_id organizationId FROM publication_jobs')
        ) {
          interleaved = true
          other
            .prepare(
              "UPDATE publication_jobs SET lease_token='new-token',lease_owner='new-worker',lease_expires_at=datetime('now','+3 minutes') WHERE id=?",
            )
            .run(firstJob.id)
        }
        return db.prepare(sql)
      },
      exec(sql) {
        return db.exec(sql)
      },
    }
    const result = await runHealthCheck(monitorDb, { autoRecover: true })
    assert(interleaved, 'O teste precisa simular a troca de lease após a leitura')
    assert.equal(result.recoveredCount, 0)
    assert.deepEqual(
      {
        ...db
          .prepare('SELECT status,lease_token token FROM publication_jobs WHERE id=?')
          .get(firstJob.id),
      },
      { status: 'filling', token: 'new-token' },
    )
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM publication_job_events WHERE publication_job_id=? AND event_type IN ('stalled_recovered','stalled_exhausted','stalled_publish_ambiguous')",
        )
        .get(firstJob.id).n,
      0,
    )
  } finally {
    other.close()
  }
  console.log('✓ Phase 1: unique open jobs, daily capacity and stale lease fencing')
} finally {
  db.close()
  await server.close()
}
