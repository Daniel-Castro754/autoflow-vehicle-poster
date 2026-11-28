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

  // A tenant's eligibility can change after the sweep builds its initial list.
  const eligibilityEntered = deferred()
  const eligibilityRelease = deferred()
  const rechecked = []
  const result = {
    ok: true,
    processedCount: 0,
    jobsCreated: 0,
    descriptionsOptimized: 0,
    assignments: [],
    message: 'test',
  }
  const revalidation = createAutonomousScheduler(db, {
    maxConcurrentOrganizations: 1,
    run: async (_database, organizationId) => {
      rechecked.push(organizationId)
      if (organizationId === 1) {
        eligibilityEntered.resolve()
        await eligibilityRelease.promise
      }
      return result
    },
  })
  const revalidationSweep = revalidation.sweep()
  await eligibilityEntered.promise
  db.exec(`
    UPDATE organization_settings SET autopilot_enabled=0 WHERE organization_id=2;
    INSERT INTO autopilot_state VALUES(3,datetime('now','+10 minutes'),NULL);
    INSERT INTO autopilot_state VALUES(4,NULL,datetime('now','+2 minutes'));
  `)
  eligibilityRelease.resolve()
  await revalidationSweep
  assert.deepEqual(rechecked, [1, 5], 'Recheck disabled, postponed and claimed tenants before dispatch')
  revalidation.stop()

  // A fresh worker must honor persisted future runs and active leases.
  // Only the lease whose expiry was durably recorded in the past is eligible.
  db.exec(`
    UPDATE organization_settings SET autopilot_enabled=0 WHERE organization_id IN (1,5);
    UPDATE autopilot_state SET lease_expires_at=datetime('now','-1 second') WHERE organization_id=4;
  `)
  const recovered = []
  const replacement = createAutonomousScheduler(db, {
    run: async (_database, organizationId) => {
      recovered.push(organizationId)
      return result
    },
  })
  await replacement.sweep()
  assert.deepEqual(recovered, [4], 'A replacement worker respects persisted cadence and lease expiry')
  replacement.stop()

  // stop/start while an old round is running must discard its remaining
  // snapshot; the fresh sweep may include a newly enabled tenant.
  db.exec(`
    DELETE FROM autopilot_state;
    UPDATE organization_settings SET autopilot_enabled=1 WHERE organization_id IN (1,2);
    UPDATE organization_settings SET autopilot_enabled=0 WHERE organization_id IN (3,4,5);
  `)
  const oldEntered = deferred()
  const oldRelease = deferred()
  const restarted = []
  let inFlight = 0
  let peakRestart = 0
  const restartable = createAutonomousScheduler(db, {
    intervalMs: 60_000,
    maxConcurrentOrganizations: 1,
    run: async (_database, organizationId) => {
      restarted.push(organizationId)
      inFlight++
      peakRestart = Math.max(peakRestart, inFlight)
      if (organizationId === 1) {
        oldEntered.resolve()
        await oldRelease.promise
      }
      inFlight--
      return result
    },
  })
  const oldSweep = restartable.sweep()
  await oldEntered.promise
  restartable.stop()
  db.exec(`
    UPDATE organization_settings SET autopilot_enabled=0 WHERE organization_id=1;
    INSERT INTO autopilot_state VALUES(2,datetime('now','+1 minute'),NULL);
    UPDATE organization_settings SET autopilot_enabled=1 WHERE organization_id=3;
  `)
  // Only the newly enabled tenant is due in the fresh snapshot.
  restartable.start()
  oldRelease.resolve()
  await oldSweep
  await new Promise((resolve) => setImmediate(resolve))
  restartable.stop()
  assert.deepEqual(restarted, [1, 3], 'Restart immediately runs a fresh snapshot, not the old queue')
  assert.equal(peakRestart, 1, 'Restart cannot overlap the old round')
} finally {
  db.close()
}
console.log('✓ Phase 3: bounded concurrency, tenant isolation, safe retry categories, fresh eligibility and scheduler restart')


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
    db.exec("UPDATE social_accounts SET next_publication_allowed_at=datetime('now','+30 minutes') WHERE id=1")
    assert.deepEqual(redistributeOfflinePendingJobs(db,1,()=>true),[], 'Source cooldown cannot be bypassed')
    db.exec("UPDATE social_accounts SET next_publication_allowed_at=NULL WHERE id=1; UPDATE social_accounts SET automation_paused=1 WHERE id=2")
    assert.deepEqual(redistributeOfflinePendingJobs(db,1,()=>true),[], 'Destination safety pause respected')
    db.exec("UPDATE social_accounts SET automation_paused=0 WHERE id=2; UPDATE social_accounts SET last_seen_at=CURRENT_TIMESTAMP WHERE id=1")
    assert.deepEqual(redistributeOfflinePendingJobs(db,1,()=>true),[], 'Transient or recent source heartbeat excluded')
    db.exec("UPDATE social_accounts SET last_seen_at=datetime('now','-30 minutes') WHERE id=1; UPDATE organization_settings SET autopilot_enabled=0 WHERE organization_id=1")
    assert.deepEqual(redistributeOfflinePendingJobs(db,1,()=>true),[], 'Recurring pilot must be enabled')
    db.exec("UPDATE organization_settings SET autopilot_enabled=1 WHERE organization_id=1")
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
