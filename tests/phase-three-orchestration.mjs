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
