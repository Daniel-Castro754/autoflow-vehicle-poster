import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { listingExpiryOverview } from '../server/services/listing-expiry.ts'
import { handleListingExpiryRoute } from '../server/routes/listing-expiry.ts'

const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE organization_settings (
    organization_id INTEGER PRIMARY KEY, listing_expiry_enabled INTEGER DEFAULT 1,
    listing_expiry_days INTEGER DEFAULT 4, listing_expiry_warning INTEGER DEFAULT 1
  );
  CREATE TABLE vehicles (id INTEGER PRIMARY KEY,organization_id INTEGER,year INTEGER,
    make TEXT,model TEXT,status TEXT,sold_at TEXT);
  CREATE TABLE social_accounts (id INTEGER PRIMARY KEY,organization_id INTEGER,
    label TEXT,browser_profile TEXT,user_id INTEGER);
  CREATE TABLE publication_jobs (id INTEGER PRIMARY KEY,organization_id INTEGER,
    vehicle_id INTEGER,social_account_id INTEGER,status TEXT);
  CREATE TABLE publication_listing_ledger (id INTEGER PRIMARY KEY,organization_id INTEGER,
    vehicle_id INTEGER,publication_job_id INTEGER,status TEXT,first_confirmed_at TEXT,
    external_listing_id TEXT,canonical_url TEXT,expiry_review_until TEXT);
  INSERT INTO organization_settings(organization_id) VALUES(1),(2);
  INSERT INTO social_accounts VALUES(1,1,'Daniel','Profile 1',1),(2,1,'Pai','Profile 2',2),
    (3,2,'Outra empresa','Default',3);
`)
const now = Date.now()
function insert(id, age, { org = 1, account = 1, sold = false, status = 'completed', ledger = true,
  listingId = String(id), ledgerStatus = 'active' } = {}) {
  db.prepare('INSERT INTO vehicles VALUES(?,?,?,?,?,?,?)').run(
    id, org, 2022, 'Toyota', 'Corolla', sold ? 'Vendido' : 'Publicado', null,
  )
  db.prepare('INSERT INTO publication_jobs VALUES(?,?,?,?,?)').run(id, org, id, account, status)
  if (ledger) db.prepare('INSERT INTO publication_listing_ledger VALUES(?,?,?,?,?,?,?,?,?)').run(
    id, org, id, id, ledgerStatus, new Date(now - age * 3600000).toISOString(), listingId,
    'https://www.facebook.com/marketplace/item/' + id, null,
  )
}
insert(1, 95)
insert(2, 96)
insert(3, 1, { sold: true })
insert(4, 200, { listingId: '' })
insert(5, 200, { ledger: false })
insert(6, 20, { account: 2 })
insert(7, 200, { org: 2, account: 3 })
insert(8, 200, { status: 'removed', ledgerStatus: 'removed' })
insert(9, 200, { status: 'awaiting_confirmation' })
insert(10, -1)
insert(11, 1, { listingId: null })

const get = (user = null, at = now) => listingExpiryOverview(db, 1, user, at)
const state = (id) => get().items.find((item) => item.jobId === id)?.state
assert.deepEqual(get().policy, { enabled: true, days: 4, warning: true })
assert.equal(state(1), 'warning')
assert.equal(state(2), 'expired')
assert.equal(state(3), 'sold')
assert.equal(state(4), 'review')
assert.equal(state(5), 'review')
assert.equal(state(6), 'active')
assert.equal(state(7), undefined)
assert.equal(state(8), undefined)
assert.equal(state(9), undefined)
assert.equal(state(10), 'review')
assert.equal(state(11), 'active')
assert.equal(get().items[0].jobId, 3)
assert.equal(get(2).items.length, 1)
assert.equal(get(2).items[0].jobId, 6)
assert.equal(get().items.find((item) => item.jobId === 11).canonicalUrl, '')
assert.equal(get().items.find((item) => item.jobId === 4).canonicalUrl, '')

db.prepare('UPDATE publication_listing_ledger SET expiry_review_until=? WHERE id=2').run(
  new Date(now + 2 * 86400000).toISOString(),
)
assert.equal(state(2), 'active')
db.exec('UPDATE organization_settings SET listing_expiry_enabled=0 WHERE organization_id=1')
assert.equal(state(1), 'disabled')
assert.equal(state(3), 'sold')
db.exec('UPDATE organization_settings SET listing_expiry_enabled=1 WHERE organization_id=1')

const events = []
let response
let body = {}
const deps = {
  db,
  send: (_res, status, payload) => { response = { status, payload } },
  jsonBody: async () => body,
  isAdmin: (auth) => auth.userId === 1,
  canManageJobs: ([id], auth) => Boolean(db.prepare(
    `SELECT j.id FROM publication_jobs j JOIN social_accounts a ON a.id=j.social_account_id
      WHERE j.id=? AND j.organization_id=? AND (?=1 OR a.user_id=?)`,
  ).get(id, auth.organizationId, auth.userId, auth.userId)),
  recordJobEvent: (...args) => events.push(args),
}
async function call(method, path, userId = 1, input = {}) {
  body = input
  response = undefined
  const matched = await handleListingExpiryRoute(
    { method }, {}, new URL('http://localhost/api/publications/' + path),
    { organizationId: 1, userId }, deps,
  )
  assert.equal(matched, true)
  return response
}
assert.equal((await call('PATCH', 'listing-expiry', 2, { enabled: true, days: 7, warning: true })).status, 403)
assert.equal((await call('PATCH', 'listing-expiry', 1, { enabled: true, days: 0, warning: true })).status, 400)
assert.equal((await call('PATCH', 'listing-expiry', 1, { enabled: true, days: 7, warning: false })).status, 200)
assert.equal(get().policy.days, 7)
assert.equal((await call('GET', 'listing-expiry', 2)).payload.items.length, 1)
assert.equal((await call('PATCH', '1/extend-listing-expiry', 2, { days: 3 })).status, 403)
assert.equal((await call('PATCH', '3/extend-listing-expiry', 1, { days: 3 })).status, 409)
assert.equal((await call('PATCH', '4/extend-listing-expiry', 1, { days: 3 })).status, 409)
assert.equal((await call('PATCH', '8/extend-listing-expiry', 1, { days: 3 })).status, 409)
assert.equal((await call('PATCH', '7/extend-listing-expiry', 1, { days: 3 })).status, 403)
assert.equal((await call('PATCH', '1/extend-listing-expiry', 1, { days: 3 })).status, 200)
assert.equal(events.length, 1)
assert.equal(events[0][2], 'listing_expiry_extended')
assert.equal(db.prepare('SELECT status FROM publication_jobs WHERE id=2').get().status, 'completed')
assert.equal(db.prepare('SELECT status FROM publication_listing_ledger WHERE id=2').get().status, 'active')
db.close()
console.log('OK: validade de anúncios, prorrogação, data incerta, vendidos e isolamento por perfil.')
