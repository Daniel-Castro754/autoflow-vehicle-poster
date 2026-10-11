import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  activeListingEvidence,
  canonicalMarketplaceListing,
  markListingRemoved,
  recordConfirmedListing,
} from '../server/services/publication-ledger.ts'
import { publicationDuplicateRisk } from '../server/services/publication-policy.ts'

assert.deepEqual(
  canonicalMarketplaceListing('https://www.facebook.com/marketplace/item/123456789/?ref=share'),
  {
    externalListingId: '123456789',
    canonicalUrl: 'https://www.facebook.com/marketplace/item/123456789',
  },
)
assert.deepEqual(
  canonicalMarketplaceListing('https://m.facebook.com/marketplace/item/123456789?foo=1'),
  {
    externalListingId: '123456789',
    canonicalUrl: 'https://www.facebook.com/marketplace/item/123456789',
  },
)
assert.equal(
  canonicalMarketplaceListing('https://example.com/marketplace/item/123').externalListingId,
  '',
)
assert.equal(canonicalMarketplaceListing('javascript:alert(1)').canonicalUrl, '')
assert.equal(
  canonicalMarketplaceListing('https://facebook.com/marketplace/item/late-1').externalListingId,
  'late-1',
)

const db = new DatabaseSync(':memory:')
db.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE organizations(id INTEGER PRIMARY KEY);
  CREATE TABLE vehicles(id INTEGER PRIMARY KEY,organization_id INTEGER,year INTEGER,make TEXT,model TEXT);
  CREATE TABLE social_accounts(id INTEGER PRIMARY KEY,organization_id INTEGER,label TEXT);
  CREATE TABLE publication_jobs(
    id INTEGER PRIMARY KEY,organization_id INTEGER,vehicle_id INTEGER,social_account_id INTEGER,
    status TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE vehicle_images(
    id INTEGER PRIMARY KEY,organization_id INTEGER,vehicle_id INTEGER,content_hash TEXT
  );
  CREATE TABLE publication_listing_ledger (
    id INTEGER PRIMARY KEY,organization_id INTEGER NOT NULL,vehicle_id INTEGER NOT NULL,
    publication_job_id INTEGER NOT NULL,social_account_id INTEGER,platform TEXT NOT NULL DEFAULT 'facebook_marketplace',
    external_listing_id TEXT,canonical_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',first_confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,removed_at TEXT,
    UNIQUE(organization_id,publication_job_id),UNIQUE(organization_id,platform,external_listing_id)
  );
  CREATE TABLE published_ads(
    id INTEGER PRIMARY KEY,organization_id INTEGER,publication_job_id INTEGER,
    listing_hash TEXT,status TEXT,published_at TEXT,removed_at TEXT
  );
  INSERT INTO organizations VALUES (1),(2);
  INSERT INTO vehicles VALUES (10,1,2022,'Toyota','Corolla'),(20,2,2022,'Toyota','Corolla');
  INSERT INTO social_accounts VALUES (5,1,'Principal'),(6,2,'Outra empresa');
  INSERT INTO publication_jobs VALUES (100,1,10,5,'removed',CURRENT_TIMESTAMP);
  INSERT INTO publication_jobs VALUES (200,2,20,6,'removed',CURRENT_TIMESTAMP);
`)

recordConfirmedListing(db, {
  organizationId: 1,
  vehicleId: 10,
  publicationJobId: 100,
  socialAccountId: 5,
  resultUrl: 'https://facebook.com/marketplace/item/998877/?tracking=abc',
})
let evidence = activeListingEvidence(db, 1, 10)
assert.equal(evidence?.externalListingId, '998877')
assert.equal(evidence?.canonicalUrl, 'https://www.facebook.com/marketplace/item/998877')
let risk = publicationDuplicateRisk(db, 1, 10, 999)
assert.equal(risk?.type, 'active_external_listing')
assert.match(String(risk?.message), /anúncio externo/i)

recordConfirmedListing(db, {
  organizationId: 1,
  vehicleId: 10,
  publicationJobId: 100,
  socialAccountId: 5,
  resultUrl: 'https://m.facebook.com/marketplace/item/998877?ref=share',
})
assert.equal(
  db.prepare('SELECT COUNT(*) total FROM publication_listing_ledger WHERE organization_id=1').get()
    .total,
  1,
  'Equivalent URLs must update the same ledger row.',
)

markListingRemoved(db, 1, 100)
assert.equal(activeListingEvidence(db, 1, 10), undefined)
assert.equal(publicationDuplicateRisk(db, 1, 10, 100), null)

recordConfirmedListing(db, {
  organizationId: 2,
  vehicleId: 20,
  publicationJobId: 200,
  socialAccountId: 6,
  resultUrl: 'https://facebook.com/marketplace/item/223344',
})
assert.equal(activeListingEvidence(db, 1, 20), undefined, 'Ledger evidence must be tenant-scoped.')

const noUrlJob = Number(
  db
    .prepare(
      "INSERT INTO publication_jobs(organization_id,vehicle_id,social_account_id,status) VALUES (1,10,5,'completed')",
    )
    .run().lastInsertRowid,
)
recordConfirmedListing(db, {
  organizationId: 1,
  vehicleId: 10,
  publicationJobId: noUrlJob,
  socialAccountId: 5,
})
assert.equal(
  db
    .prepare(
      'SELECT external_listing_id externalId FROM publication_listing_ledger WHERE publication_job_id=?',
    )
    .get(noUrlJob).externalId,
  null,
)

const reusedJob = Number(
  db
    .prepare(
      "INSERT INTO publication_jobs(organization_id,vehicle_id,social_account_id,status) VALUES (1,10,5,'completed')",
    )
    .run().lastInsertRowid,
)
recordConfirmedListing(db, {
  organizationId: 1,
  vehicleId: 10,
  publicationJobId: reusedJob,
  socialAccountId: 5,
  resultUrl: 'https://facebook.com/marketplace/item/998877',
})
assert.equal(
  db
    .prepare(
      "SELECT publication_job_id jobId FROM publication_listing_ledger WHERE external_listing_id='998877'",
    )
    .get().jobId,
  100,
  'An external listing ID must keep its original job provenance.',
)

console.log(
  '✓ Listing ledger: canonical URL, durable duplicate evidence, removal and tenant isolation.',
)
