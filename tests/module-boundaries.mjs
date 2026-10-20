import assert from 'node:assert/strict'
import { handleMediaRequest } from '../server/modules/media.ts'
import { createVehicleModule } from '../server/modules/vehicles.ts'
import { createFacebookMarketplaceModule } from '../server/modules/facebook-marketplace.ts'

// New modules must never silently claim unrelated paths, especially the
// unauthenticated media module. Routing to existing handlers is unchanged.
const calls = []
const send = (_res, status, payload) => calls.push({ status, payload })
const noDb = {
  prepare() {
    throw new Error('No database call allowed for unmatched paths')
  },
}
const req = { method: 'GET' }
const res = {}
assert.equal(
  await handleMediaRequest(req, res, new URL('http://localhost/api/vehicles'), {
    db: noDb,
    uploadsDir: '/unused',
    secret: 'not-used',
    send,
  }),
  false,
)
assert.deepEqual(calls, [])
assert.equal(
  await handleMediaRequest(req, res, new URL('http://localhost/uploads/variants/0/1/x.jpg'), {
    db: noDb,
    uploadsDir: '/unused',
    secret: 'not-used',
    send,
  }),
  false,
)
assert.equal(typeof createVehicleModule, 'function')
assert.equal(typeof createFacebookMarketplaceModule, 'function')
console.log('OK: modular routes do not intercept unrelated media paths.')
