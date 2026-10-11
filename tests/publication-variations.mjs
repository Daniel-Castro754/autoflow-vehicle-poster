import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import {
  pickRandomOrderedSubset,
  publicationPhotoRandom,
  optimizeFaithfulPhoto,
  renderMildPhotoVariant,
  signedPublicationPhotoToken,
} from '../server/services/image-manager.ts'
import {
  listingSnapshotForVehicle,
  calculateListingHash,
  reserveListingHash,
  confirmPublishedHash,
  findDuplicateListingHash,
  markPublishedHashRemoved,
  DuplicateListingHashError,
} from '../server/services/duplicate-checker.ts'
import { publishWithRandomDelay } from '../server/services/publication-service.ts'
import { profileCapacity } from '../server/services/profile-capacity.ts'

const images = [
  { id: 1, category: 'front' },
  { id: 2, category: 'rear' },
  { id: 3, category: 'interior' },
  { id: 4, category: 'rear' },
  { id: 5, category: 'interior' },
  { id: 6, category: 'dashboard' },
]
const selection = pickRandomOrderedSubset(images, 20, publicationPhotoRandom(42))
assert.equal(selection[0].id, 1, 'Approved cover must remain the first photo.')
assert.deepEqual(
  selection.filter((p) => p.category === 'rear').map((p) => p.id),
  [2, 4],
  'Rear photo ordering must remain intact.',
)
assert.deepEqual(
  selection.filter((p) => p.category === 'interior').map((p) => p.id),
  [3, 5],
  'Interior photo ordering must remain intact.',
)
for (const category of ['rear', 'interior']) {
  const positions = selection.flatMap((photo, index) =>
    photo.category === category ? [index] : [],
  )
  assert.equal(positions[1], positions[0] + 1, 'Category must stay in one block.')
}
assert.deepEqual(
  pickRandomOrderedSubset(images, 20, publicationPhotoRandom(42)),
  selection,
  'Retries must use the same category ordering.',
)
assert.equal(new Set(selection.map((p) => p.id)).size, images.length)

const real = await sharp({
  create: { width: 2500, height: 1250, channels: 3, background: '#ffffff' },
})
  .png()
  .toBuffer()
const optimized = await optimizeFaithfulPhoto(real)
const info = await sharp(optimized).metadata()
assert.equal(info.format, 'jpeg')
assert(info.width <= 1600 && info.height <= 1600)
const mild = await renderMildPhotoVariant(real, 1, 1)
assert.equal((await sharp(mild).metadata()).format, 'jpeg')
assert.deepEqual(
  await renderMildPhotoVariant(real, 1, 1),
  mild,
  'Image edits must be deterministic.',
)
assert.equal(signedPublicationPhotoToken('secret', 1, 1, 1).length, 64)
assert.notEqual(
  signedPublicationPhotoToken('secret', 1, 1, 1),
  signedPublicationPhotoToken('secret', 1, 1, 2),
)

const db = new DatabaseSync(':memory:')
try {
  initializeBaseSchema(db)
  applyMigrations(db)
  assert.equal(db.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count, 25)
  db.exec(`
    INSERT INTO organizations(id,name) VALUES(1,'Test'),(2,'Other');
    INSERT INTO users(id,organization_id,name,email,password_hash) VALUES
      (1,1,'User','owner@example.local','hash'),(2,2,'Other','other@example.local','hash');
    INSERT INTO organization_settings(organization_id,daily_limit,execution_interval_minutes)
      VALUES (1,10,25),(2,10,25);
    INSERT INTO social_accounts(id,organization_id,user_id,label)
      VALUES(1,1,1,'Test profile'),(2,2,2,'Other profile');
    INSERT INTO vehicles(id,organization_id,year,make,model,trim,price,description)
      VALUES
      (1,1,2021,'Toyota','Corolla','XEi',98000,'Sedã à venda.'),
      (2,1,2021,'Toyota','Corolla','XEi',98000,'Sedã à venda.'),
      (3,2,2021,'Toyota','Corolla','XEi',98000,'Sedã à venda.');
    INSERT INTO publication_jobs(id,organization_id,vehicle_id,social_account_id,status)
      VALUES (1,1,1,1,'pending'),(2,1,2,1,'pending'),(3,2,3,2,'pending');
  `)
  const first = listingSnapshotForVehicle(db, 1, 1)
  const second = listingSnapshotForVehicle(db, 1, 2)
  // Existing jobs have no stored seed after the additive migration. They
  // must continue using the exact pre-seed editorial rendering.
  assert.equal(
    db.prepare('SELECT variant_seed FROM publication_jobs WHERE id=1').get().variant_seed,
    null,
  )
  const legacySnapshot = listingSnapshotForVehicle(db, 1, 1)
  assert.deepEqual(legacySnapshot, first)
  const seededCopy = listingSnapshotForVehicle(db, 1, 1, 123456)
  assert.deepEqual(listingSnapshotForVehicle(db, 1, 1, 123456), seededCopy)
  assert(seededCopy.title && seededCopy.description.includes('AF-000001'))
  assert.equal(seededCopy.price, first.price)
  const hash = calculateListingHash(first)
  const secondHash = calculateListingHash(second)
  assert(first.description.includes('AF-000001'))
  assert(second.description.includes('AF-000002'))
  assert.notEqual(
    hash,
    secondHash,
    'Two inventory units can have the same model, price and original copy.',
  )
  assert.deepEqual(listingSnapshotForVehicle(db, 1, 1), first, 'Text remains stable on retry.')
  assert.match(hash, /^[a-f0-9]{64}$/)
  assert.notEqual(calculateListingHash({ ...first, price: first.price + 1 }), hash)
  db.exec('BEGIN IMMEDIATE')
  reserveListingHash(db, 1, 1, 1, hash)
  db.exec('COMMIT')
  assert.equal(findDuplicateListingHash(db, 1, hash)?.jobId, 1)
  assert.throws(() => reserveListingHash(db, 1, 2, 2, hash), DuplicateListingHashError)
  reserveListingHash(db, 1, 2, 2, secondHash)
  // Organizations are isolated by their own hash namespace.
  reserveListingHash(db, 2, 3, 3, hash)
  assert.equal(confirmPublishedHash(db, 1, 1), true)
  assert.equal(confirmPublishedHash(db, 1, 1), false)
  const before = Date.now()
  const cooldown = publishWithRandomDelay(db, 1, 1, 6)
  const elapsed = Date.parse(cooldown.nextAllowedAt) - before
  assert(elapsed >= 31 * 60_000 - 1000 && elapsed <= 31 * 60_000 + 1000)
  const capacity = profileCapacity(db, 1, 1)
  assert(capacity.retryAfterSeconds >= 30 * 60)
  markPublishedHashRemoved(db, 1, 1)
  assert.equal(findDuplicateListingHash(db, 1, hash), undefined)
  assert.equal(findDuplicateListingHash(db, 1, secondHash)?.jobId, 2)
} finally {
  db.close()
}
console.log(
  '✓ Publication variation: category blocks, faithful Sharp resize, scoped hashes, idempotency and cooldown.',
)
