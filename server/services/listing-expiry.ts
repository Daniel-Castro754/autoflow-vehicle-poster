import type { DatabaseSync } from 'node:sqlite'
import { canonicalMarketplaceListing } from './publication-ledger.ts'

const DAY_MS = 86_400_000

export function listingExpiryPolicy(db: DatabaseSync, organizationId: number) {
  const row = db
    .prepare(
      `SELECT listing_expiry_enabled enabled,listing_expiry_days days,listing_expiry_warning warning
      FROM organization_settings WHERE organization_id=?`,
    )
    .get(organizationId) as { enabled: number; days: number; warning: number } | undefined
  return {
    enabled: row?.enabled !== 0,
    days: row && Number.isInteger(row.days) && row.days >= 1 && row.days <= 90 ? row.days : 4,
    warning: row?.warning !== 0,
  }
}

function utcTime(value: string | null) {
  if (!value) return NaN
  const normalized = value.replace(' ', 'T')
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(normalized) ? normalized : normalized + 'Z')
}

type ListingRow = {
  jobId: number
  accountId: number | null
  accountLabel: string
  browserProfile: string
  year: number
  make: string
  model: string
  sold: number
  confirmedAt: string | null
  externalListingId: string | null
  canonicalUrl: string | null
  reviewUntil: string | null
  ledgerId: number | null
}

export function listingExpiryOverview(
  db: DatabaseSync,
  organizationId: number,
  userId: number | null,
  now = Date.now(),
) {
  const policy = listingExpiryPolicy(db, organizationId)
  const rows = db
    .prepare(
      `SELECT j.id jobId,j.social_account_id accountId,
        COALESCE(a.label,'Perfil não definido') accountLabel,
        COALESCE(a.browser_profile,'') browserProfile,
        v.year,v.make,v.model,
        CASE WHEN v.status='Vendido' OR v.sold_at IS NOT NULL THEN 1 ELSE 0 END sold,
        l.id ledgerId,l.first_confirmed_at confirmedAt,l.external_listing_id externalListingId,
        l.canonical_url canonicalUrl,l.expiry_review_until reviewUntil
      FROM publication_jobs j
      JOIN vehicles v ON v.id=j.vehicle_id AND v.organization_id=j.organization_id
      LEFT JOIN social_accounts a ON a.id=j.social_account_id AND a.organization_id=j.organization_id
      LEFT JOIN publication_listing_ledger l ON l.publication_job_id=j.id
        AND l.organization_id=j.organization_id AND l.vehicle_id=v.id
      WHERE j.organization_id=? AND j.status='completed'
        AND (l.id IS NULL OR l.status='active')
        AND (? IS NULL OR a.user_id=?)`,
    )
    .all(organizationId, userId, userId) as ListingRow[]
  const items = rows.map((row) => {
    // The legacy migration copied approximate times for rows with an empty
    // external ID. Do not treat those times as confirmed publication dates.
    const stamp =
      row.ledgerId !== null && row.externalListingId !== '' ? utcTime(row.confirmedAt) : NaN
    const trustedTime = Number.isFinite(stamp) && stamp <= now
    const review = utcTime(row.reviewUntil)
    const deadline = trustedTime
      ? Math.max(stamp + policy.days * DAY_MS, Number.isFinite(review) ? review : 0)
      : NaN
    const state = row.sold
      ? 'sold'
      : !trustedTime
        ? 'review'
        : !policy.enabled
          ? 'disabled'
          : deadline <= now
            ? 'expired'
            : policy.warning && deadline - now <= DAY_MS
              ? 'warning'
              : 'active'
    const listing = canonicalMarketplaceListing(row.canonicalUrl)
    const safeUrl =
      row.externalListingId && listing.externalListingId === row.externalListingId
        ? listing.canonicalUrl
        : ''
    return {
      jobId: row.jobId,
      accountLabel: row.accountLabel,
      browserProfile: row.browserProfile,
      vehicle: `${row.year} ${row.make} ${row.model}`,
      state,
      confirmedAt: trustedTime ? new Date(stamp).toISOString() : null,
      ageHours: trustedTime ? Math.floor((now - stamp) / 3_600_000) : null,
      expiresAt: Number.isFinite(deadline) ? new Date(deadline).toISOString() : null,
      canonicalUrl: safeUrl,
      canExtend: Boolean(policy.enabled && !row.sold && trustedTime),
    }
  })
  const order: Record<string, number> = {
    sold: 0,
    expired: 1,
    review: 2,
    warning: 3,
    active: 4,
    disabled: 5,
  }
  items.sort(
    (a, b) =>
      order[a.state]! - order[b.state]! ||
      (a.expiresAt || '').localeCompare(b.expiresAt || '') ||
      a.jobId - b.jobId,
  )
  return { policy, items }
}
