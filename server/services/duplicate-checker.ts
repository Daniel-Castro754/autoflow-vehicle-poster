import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { renderVehicleListingCopy } from './listing-copy-variants.ts'

export type ListingContent = { title: string; description: string; price: number }

export class DuplicateListingHashError extends Error {
  readonly conflictingJobId: number
  constructor(conflictingJobId: number) {
    super(
      'Um anúncio com o mesmo título, descrição e preço já está na fila ou publicado (trabalho #' +
        conflictingJobId +
        '). Resolva o anúncio existente antes de tentar novamente.',
    )
    this.conflictingJobId = conflictingJobId
  }
}

export function listingSnapshotForVehicle(
  db: DatabaseSync,
  organizationId: number,
  vehicleId: number,
): ListingContent | undefined {
  const facts = db
    .prepare(
      `SELECT v.id,v.year,v.make,v.model,v.trim,v.price,
       CASE WHEN length(v.description)>0 THEN v.description
         ELSE printf('%d %s %s %s com %d km. Entre em contato para consultar disponibilidade e condições.',v.year,v.make,v.model,v.trim,v.km)
       END description
       FROM vehicles v WHERE v.id=? AND v.organization_id=?`,
    )
    .get(vehicleId, organizationId) as
    | { id: number; year: number; make: string; model: string; trim: string; price: number; description: string }
    | undefined
  return facts ? renderVehicleListingCopy(facts) : undefined
}

export function calculateListingHash(content: ListingContent): string {
  const price = Number(content.price)
  if (!Number.isSafeInteger(price) || price <= 0)
    throw new Error('Preço inválido para assinatura da publicação.')
  const normalized = (value: string) =>
    String(value || '')
      .normalize('NFC')
      .trim()
      .replace(/\s+/g, ' ')
  const title = normalized(content.title)
  const description = normalized(content.description)
  if (!title || !description) throw new Error('O anúncio precisa de título e descrição.')
  return createHash('sha256').update(JSON.stringify([title, description, price])).digest('hex')
}

export function findDuplicateListingHash(
  db: DatabaseSync,
  organizationId: number,
  hash: string,
  excludeJobId = 0,
): { jobId: number; status: string } | undefined {
  return db
    .prepare(
      `SELECT publication_job_id jobId,status FROM published_ads
       WHERE organization_id=? AND listing_hash=? AND publication_job_id!=?
         AND status IN ('queued','published') LIMIT 1`,
    )
    .get(organizationId, hash, excludeJobId) as
    | { jobId: number; status: string }
    | undefined
}

// Must be called inside the same BEGIN IMMEDIATE transaction as job creation.
// The partial UNIQUE index also guards against concurrent processes.
export function reserveListingHash(
  db: DatabaseSync,
  organizationId: number,
  vehicleId: number,
  publicationJobId: number,
  hash: string,
) {
  const existing = db
    .prepare(
      'SELECT listing_hash listingHash FROM published_ads WHERE organization_id=? AND publication_job_id=?',
    )
    .get(organizationId, publicationJobId) as { listingHash: string } | undefined
  if (existing) {
    if (existing.listingHash !== hash) throw new Error('Os dados do anúncio mudaram após entrar na fila.')
    return
  }
  const conflict = findDuplicateListingHash(db, organizationId, hash, publicationJobId)
  if (conflict) throw new DuplicateListingHashError(conflict.jobId)
  db.prepare(
    `INSERT INTO published_ads
       (organization_id,vehicle_id,publication_job_id,listing_hash,status)
       VALUES (?,?,?,?,'queued')`,
  ).run(organizationId, vehicleId, publicationJobId, hash)
}

export function confirmPublishedHash(
  db: DatabaseSync,
  organizationId: number,
  publicationJobId: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE published_ads SET status='published',
       published_at=COALESCE(published_at,CURRENT_TIMESTAMP),removed_at=NULL
       WHERE organization_id=? AND publication_job_id=? AND status='queued'`,
    )
    .run(organizationId, publicationJobId)
  return result.changes === 1
}

export function releaseUnpublishedHash(
  db: DatabaseSync,
  organizationId: number,
  publicationJobId: number,
) {
  db.prepare(
    `UPDATE published_ads SET status='removed',removed_at=CURRENT_TIMESTAMP
     WHERE organization_id=? AND publication_job_id=? AND status='queued'`,
  ).run(organizationId, publicationJobId)
}

export function markPublishedHashRemoved(
  db: DatabaseSync,
  organizationId: number,
  publicationJobId: number,
) {
  db.prepare(
    `UPDATE published_ads SET status='removed',removed_at=CURRENT_TIMESTAMP
     WHERE organization_id=? AND publication_job_id=?`,
  ).run(organizationId, publicationJobId)
}
