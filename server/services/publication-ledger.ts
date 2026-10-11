import type { DatabaseSync } from 'node:sqlite'

export function canonicalMarketplaceListing(value: unknown) {
  const raw = String(value || '')
    .trim()
    .slice(0, 1000)
  if (!raw) return { externalListingId: '', canonicalUrl: '' }
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (host !== 'facebook.com' && host !== 'm.facebook.com')
      return { externalListingId: '', canonicalUrl: '' }
    const match = url.pathname.match(/\/marketplace\/item\/([A-Za-z0-9_-]+)/)
    if (!match) return { externalListingId: '', canonicalUrl: '' }
    return {
      externalListingId: match[1].slice(0, 200),
      canonicalUrl: 'https://www.facebook.com/marketplace/item/' + match[1],
    }
  } catch {
    return { externalListingId: '', canonicalUrl: '' }
  }
}

export function recordConfirmedListing(
  db: DatabaseSync,
  input: {
    organizationId: number
    vehicleId: number
    publicationJobId: number
    socialAccountId: number | null
    resultUrl?: unknown
  },
) {
  const listing = canonicalMarketplaceListing(input.resultUrl)
  // A successful publish without a trustworthy listing URL is still evidence
  // for this job/vehicle, but must not participate in the cross-job external-ID unique key.
  const storedExternalId = listing.externalListingId || null
  db.prepare(
    `INSERT INTO publication_listing_ledger
      (organization_id,vehicle_id,publication_job_id,social_account_id,external_listing_id,canonical_url,status)
      VALUES (?,?,?,?,?,?,'active')
      ON CONFLICT(organization_id,publication_job_id) DO UPDATE SET
        social_account_id=excluded.social_account_id,
        external_listing_id=CASE WHEN excluded.external_listing_id!='' THEN excluded.external_listing_id ELSE publication_listing_ledger.external_listing_id END,
        canonical_url=CASE WHEN excluded.canonical_url!='' THEN excluded.canonical_url ELSE publication_listing_ledger.canonical_url END,
        status='active',last_confirmed_at=CURRENT_TIMESTAMP,removed_at=NULL`,
  ).run(
    input.organizationId,
    input.vehicleId,
    input.publicationJobId,
    input.socialAccountId,
    storedExternalId,
    listing.canonicalUrl,
  )
  return listing
}

export function markListingRemoved(
  db: DatabaseSync,
  organizationId: number,
  publicationJobId: number,
) {
  db.prepare(
    `UPDATE publication_listing_ledger
      SET status='removed',removed_at=CURRENT_TIMESTAMP,last_confirmed_at=CURRENT_TIMESTAMP
      WHERE organization_id=? AND publication_job_id=?`,
  ).run(organizationId, publicationJobId)
}

export function activeListingEvidence(
  db: DatabaseSync,
  organizationId: number,
  vehicleId: number,
  excludeJobId = 0,
) {
  return db
    .prepare(
      `SELECT ledger.publication_job_id jobId,ledger.external_listing_id externalListingId,
      ledger.canonical_url canonicalUrl,ledger.last_confirmed_at lastConfirmedAt,
      COALESCE(account.label,'Perfil não definido') accountLabel
    FROM publication_listing_ledger ledger
    LEFT JOIN social_accounts account ON account.id=ledger.social_account_id
    WHERE ledger.organization_id=? AND ledger.vehicle_id=? AND ledger.publication_job_id!=?
      AND ledger.status='active'
    ORDER BY datetime(ledger.last_confirmed_at) DESC,ledger.id DESC LIMIT 1`,
    )
    .get(organizationId, vehicleId, excludeJobId) as Record<string, unknown> | undefined
}
