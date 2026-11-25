import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  boundedAutopilotConcurrency,
  createAutonomousScheduler,
} from '../server/services/autonomous-scheduler.ts'
import {
  classifyExtensionFailure,
  isRetryableExtensionFailureCode,
} from '../server/services/publication-policy.ts'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

assert.equal(boundedAutopilotConcurrency(0), 3)
assert.equal(boundedAutopilotConcurrency('invalid'), 3)
assert.equal(boundedAutopilotConcurrency(1), 1)
assert.equal(boundedAutopilotConcurrency(20), 4)
assert.equal(boundedAutopilotConcurrency(2.5), 3)

const transient = classifyExtensionFailure('marketplace_form_timeout')
assert.deepEqual(transient, {
  code: 'marketplace_form_timeout',
  category: 'transient',
  disposition: 'retry',
  retryable: true,
})
assert.equal(isRetryableExtensionFailureCode('marketplace_navigation_timeout'), true)
for (const [code, category] of [
  ['facebook_auth_required', 'authentication'],
  ['facebook_checkpoint_required', 'authentication'],
  ['photo_identity_unverified', 'safety'],
  ['selector_layout_drift', 'safety'],
  ['publish_outcome_unknown', 'safety'],
]) {
  const result = classifyExtensionFailure(code)
  assert.equal(result.retryable, false, code)
  assert.equal(result.disposition, 'intervention', code)
  assert.equal(result.category, category)
}
assert.equal(classifyExtensionFailure('vehicle_data_invalid').disposition, 'terminal')
assert.deepEqual(classifyExtensionFailure('fake_timeout_exploit'), {
  code: null,
  category: 'unknown',
  disposition: 'intervention',
  retryable: false,
})
assert.deepEqual(classifyExtensionFailure(''), classifyExtensionFailure('unknown'))

// Independent organizations can advance even if the first has a slow AI call.
const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE organization_settings (organization_id INTEGER, autopilot_enabled INTEGER);
  CREATE TABLE autopilot_state (organization_id INTEGER, next_run_at TEXT, lease_expires_at TEXT);
  INSERT INTO organization_settings VALUES(1,1),(2,1),(3,1),(4,1),(5,1);
`)
try {
  const firstRelease = deferred()
  const firstEntered = deferred()
  const thirdEntered = deferred()
  let running = 0
  let peak = 0
  const started = []
  const scheduler = createAutonomousScheduler(db, {
    maxConcurrentOrganizations: 2,
    run: async (_database, organizationId) => {
      running++
      peak = Math.max(peak, running)
      started.push(organizationId)
      if (organizationId === 1) {
        firstEntered.resolve()
        await firstRelease.promise
      }
      if (organizationId === 3) thirdEntered.resolve()
      // Resolve other organizations rapidly; the pool should keep draining.
      running--
      return {
        ok: true,
        processedCount: 0,
        jobsCreated: 0,
        descriptionsOptimized: 0,
        assignments: [],
        message: 'test',
      }
    },
  })
  const sweep = scheduler.sweep()
  await firstEntered.promise
  await thirdEntered.promise
  assert.deepEqual(
    started.slice(0, 3),
    [1, 2, 3],
    'A second lane must run other tenants while the first is blocked',
  )
  await scheduler.sweep()
  assert(peak <= 2, 'The bounded pool must never exceed the configured concurrency')
  firstRelease.resolve()
  await sweep
  assert.deepEqual(started, [1, 2, 3, 4, 5])
  assert.equal(running, 0)
  scheduler.stop()
  await scheduler.sweep()
  assert.equal(started.length, 5, 'Stopped worker must not start new jobs')

  const failures = []
  const resilient = createAutonomousScheduler(db, {
    maxConcurrentOrganizations: 3,
    run: async (_database, organizationId) => {
      failures.push(organizationId)
      if (organizationId === 1) throw new Error('provider outage in one tenant')
      return {
        ok: true,
        processedCount: 0,
        jobsCreated: 0,
        descriptionsOptimized: 0,
        assignments: [],
        message: 'test',
      }
    },
  })
  await resilient.sweep()
  assert.deepEqual(failures, [1, 2, 3, 4, 5], 'One tenant failure must not cancel other tenants')
  resilient.stop()

  let concurrent = 0
  let peakCapped = 0
  const capped = createAutonomousScheduler(db, {
    maxConcurrentOrganizations: 99,
    run: async () => {
      concurrent++
      peakCapped = Math.max(peakCapped, concurrent)
      await new Promise((resolve) => setImmediate(resolve))
      concurrent--
      return {
        ok: true,
        processedCount: 0,
        jobsCreated: 0,
        descriptionsOptimized: 0,
        assignments: [],
        message: 'test',
      }
    },
  })
  await capped.sweep()
  assert.equal(peakCapped, 4, 'Even misconfigured pools must respect the safety ceiling')
  capped.stop()
} finally {
  db.close()
}
console.log('✓ Phase 3: bounded concurrency, tenant isolation, explicit safe retry categories')


import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { recordConsumerState } from '../server/services/execution-diagnostics.ts'
import { redistributeOfflinePendingJobs } from '../server/services/pending-job-reassignment.ts'
import { listingSnapshotForVehicle, calculateListingHash, reserveListingHash } from '../server/services/duplicate-checker.ts'

{
  const db = new DatabaseSync(':memory:')
  initializeBaseSchema(db)
  applyMigrations(db)
  try {
    db.exec(`
      INSERT INTO organizations(id,name) VALUES (1,'Teste'),(2,'Outra empresa');
      INSERT INTO users(id,organization_id,name,email,password_hash) VALUES (1,1,'Dono','owner@test','x'),(2,1,'Outro','other@test','x'),(3,2,'Externo','foreign@test','x');
      INSERT INTO organization_settings(organization_id,autopilot_enabled,daily_limit,execution_interval_minutes) VALUES (1,1,10,25),(2,1,10,25);
      INSERT INTO social_accounts(id,organization_id,user_id,label,status,last_seen_at,last_consumer_auto_run)
      VALUES (1,1,1,'Origem','connected',datetime('now','-30 minutes'),1),
      (2,1,1,'Destino','connected',CURRENT_TIMESTAMP,1),
      (3,1,2,'Outro dono','connected',CURRENT_TIMESTAMP,1),
      (4,2,3,'Outra empresa','connected',CURRENT_TIMESTAMP,1);
    `)
    for (const [id,model] of [[1,'Corolla'],[2,'Yaris'],[3,'Etios'],[4,'Hilux'],[5,'RAV4'],[6,'Camry'],[7,'Prius']]) {
      db.prepare(`INSERT INTO vehicles(id,organization_id,year,make,model,price,km,status,location,vehicle_type,
      transmission,fuel_type,body_type,exterior_color,interior_color,vehicle_condition,description)
      VALUES (?,1,2022,'Toyota',?,100000,50000,'Pronto','São Paulo','Carro/picape','Automático','Gasolina','Sedã','Preto','Preto','Excelente','Descrição real')`).run(id,model)
      db.prepare("INSERT INTO vehicle_images(organization_id,vehicle_id,file_name,original_name,mime_type,content_hash) VALUES (1,?,'test.jpg','test.jpg','image/jpeg',?)").run(id,'photo-'+id)
      db.prepare("INSERT INTO publication_jobs(id,organization_id,vehicle_id,social_account_id,status,scheduled_at) VALUES (?,1,?,1,'pending',datetime('now','-20 minutes'))").run(id,id)
      db.prepare("INSERT INTO publication_job_events(organization_id,publication_job_id,event_type,details) VALUES (1,?,'autopilot_scheduled',?)").run(id,JSON.stringify({trigger:'recurring'}))
      reserveListingHash(db,1,id,id,calculateListingHash(listingSnapshotForVehicle(db,1,id)))
    }
    db.exec(`
      UPDATE publication_jobs SET attempt_count=1 WHERE id=2;
      UPDATE publication_jobs SET status='awaiting_confirmation' WHERE id=3;
      UPDATE publication_jobs SET paused=1 WHERE id=4;
      UPDATE publication_jobs SET extension_visible=0 WHERE id=5;
      UPDATE vehicles SET sold_at=CURRENT_TIMESTAMP WHERE id=6;
      UPDATE publication_job_events SET details='{"trigger":"manual"}' WHERE publication_job_id=7;
    `)
    recordConsumerState(db,1,3,true)
    recordConsumerState(db,2,4,true)
    assert.deepEqual(redistributeOfflinePendingJobs(db,1,()=>true),[], 'Different owner/tenant and unknown destination excluded')
    recordConsumerState(db,1,2,true)
    db.exec('UPDATE social_accounts SET last_consumer_auto_run=0 WHERE id=1')
    assert.deepEqual(redistributeOfflinePendingJobs(db,1,()=>true),[], 'Intentional local pause survives restart')
    db.exec('UPDATE social_accounts SET last_consumer_auto_run=1 WHERE id=1')
    assert.deepEqual(redistributeOfflinePendingJobs(db,1,()=>false),[], 'Lease required')
    // A business-day boundary may prevent a safe same-day transfer.
    const today=db.prepare("SELECT autoflow_day(CURRENT_TIMESTAMP) day,autoflow_day(datetime('now','+1 minute')) nextDay").get()
    const moved=redistributeOfflinePendingJobs(db,1,()=>true)
    assert.equal(moved.length,today.day===today.nextDay?1:0)
    if (moved.length) {
      assert.equal(moved[0].jobId,1)
      assert.equal(moved[0].toAccountId,2)
      assert.equal(db.prepare('SELECT social_account_id id FROM publication_jobs WHERE id=1').get().id,2)
      assert.equal(db.prepare('SELECT COUNT(*) n FROM publication_jobs').get().n,7)
      assert.equal(db.prepare("SELECT COUNT(*) n FROM published_ads WHERE publication_job_id=1 AND status='queued'").get().n,1)
      assert.equal(db.prepare("SELECT COUNT(*) n FROM publication_job_events WHERE publication_job_id=1 AND event_type='reassigned'").get().n,1)
      db.exec("UPDATE social_accounts SET last_seen_at=datetime('now','-30 minutes') WHERE id=2; UPDATE social_accounts SET last_seen_at=CURRENT_TIMESTAMP WHERE id=1; UPDATE publication_jobs SET scheduled_at=datetime('now','-20 minutes') WHERE id=1")
      recordConsumerState(db,1,2,true,Date.now()-301000)
      recordConsumerState(db,1,1,true)
      assert.deepEqual(redistributeOfflinePendingJobs(db,1,()=>true),[], 'No automatic ping-pong')
    }
    console.log('✓ Pending reassignment: same job, owner and tenant; pauses, claims, sales and repeat moves protected.')
  } finally { db.close() }
}
