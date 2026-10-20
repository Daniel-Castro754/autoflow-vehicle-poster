import assert from 'node:assert/strict'
import { handleMediaRequest } from '../server/modules/media.ts'
import { createVehicleModule } from '../server/modules/vehicles.ts'
import { createFacebookMarketplaceModule } from '../server/modules/facebook-marketplace.ts'
import { createPublicationQueueModule } from '../server/modules/publication-queue.ts'
import { findBestAccountForVehicle as sharedAccountSelector } from '../server/modules/accounts.ts'
import { findBestAccountForVehicle as legacyAccountSelector } from '../server/services/session-manager.ts'

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
const unauthorized = await handleMediaRequest(
  req,
  res,
  new URL(`http://localhost/uploads/variants/5/7/${'0'.repeat(64)}.jpg`),
  {
    db: {
      prepare() {
        return {
          get() {
            return { organizationId: 1, vehicleId: 2, fileName: 'photo.jpg' }
          },
        }
      },
    },
    uploadsDir: '/unused',
    secret: 'test-only-secret',
    send,
  },
)
assert.equal(unauthorized, true)
assert.deepEqual(calls, [{ status: 403, payload: { error: 'Imagem não autorizada.' } }])

assert.equal(typeof createVehicleModule, 'function')
assert.equal(typeof createFacebookMarketplaceModule, 'function')
// The shared selector must retain the old import contract; the Facebook
// adapter no longer owns publication queue and scheduling routes.
assert.equal(sharedAccountSelector, legacyAccountSelector)
const dummyDependencies = {
  db: noDb,
  publicationRead: {},
  management: {},
  scheduling: {},
}
const queue = createPublicationQueueModule(dummyDependencies)
const publication = new URL('http://localhost/api/publications')
assert.equal(queue.acceptsPublicationRead({ method: 'GET' }, publication), true)
assert.equal(queue.acceptsPublicationRead({ method: 'POST' }, publication), false)
assert.equal(
  typeof createFacebookMarketplaceModule({ extension: {}, groups: {} }).publicationRead,
  'undefined',
)
assert.equal(typeof queue.scheduler.stop, 'function')
queue.scheduler.stop()

console.log('OK: media, account selection and queue boundaries verified.')
