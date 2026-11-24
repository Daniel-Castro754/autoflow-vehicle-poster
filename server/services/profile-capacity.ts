import type { DatabaseSync } from 'node:sqlite'
import { dailyExecutionAttempts } from './daily-capacity.ts'
import { publicationMayExist } from './publication-evidence.ts'

export type ProfileLimits = {
  accountId: number
  dailyLimit: number
  intervalMinutes: number
  organizationDailyLimit: number
  organizationIntervalMinutes: number
  dailyLimitOverride: number | null
  intervalMinutesOverride: number | null
}

const clamp = (value: unknown, fallback: number, minimum: number, maximum: number) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function profileLimits(
  db: DatabaseSync,
  organizationId: number,
  accountId: number,
): ProfileLimits {
  const account = db
    .prepare(
      'SELECT a.id, a.daily_limit_override dailyOverride, ' +
        'a.execution_interval_minutes_override intervalOverride, ' +
        's.daily_limit dailyLimit, s.execution_interval_minutes intervalMinutes ' +
        'FROM social_accounts a JOIN organization_settings s ON s.organization_id=a.organization_id ' +
        'WHERE a.id=? AND a.organization_id=?',
    )
    .get(accountId, organizationId) as
    | {
        id: number
        dailyOverride: number | null
        intervalOverride: number | null
        dailyLimit: number
        intervalMinutes: number
      }
    | undefined
  if (!account) throw new Error('Perfil de publicação não encontrado nesta empresa.')
  const organizationDailyLimit = clamp(account.dailyLimit, 10, 1, 50)
  const organizationIntervalMinutes = clamp(account.intervalMinutes, 25, 0, 1440)
  const dailyLimitOverride =
    account.dailyOverride == null
      ? null
      : clamp(account.dailyOverride, organizationDailyLimit, 1, 50)
  const intervalMinutesOverride =
    account.intervalOverride == null
      ? null
      : clamp(account.intervalOverride, organizationIntervalMinutes, 0, 1440)
  return {
    accountId,
    dailyLimit: Math.min(organizationDailyLimit, dailyLimitOverride ?? organizationDailyLimit),
    intervalMinutes: intervalMinutesOverride ?? organizationIntervalMinutes,
    organizationDailyLimit,
    organizationIntervalMinutes,
    dailyLimitOverride,
    intervalMinutesOverride,
  }
}

export function parseSqliteTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const time = Date.parse(
    /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value.replace(' ', 'T') + 'Z',
  )
  return Number.isFinite(time) ? time : null
}

export function lastProfileActivityAt(
  db: DatabaseSync,
  organizationId: number,
  accountId: number,
): number | null {
  // Count every acquired execution, including failed/retried executions. Completed
  // jobs can take longer than a claim, so also respect their completion timestamps.
  const row = db
    .prepare(
      'SELECT MAX(e.created_at) lastClaim FROM publication_job_events e ' +
        'JOIN publication_jobs j ON j.id=e.publication_job_id AND j.organization_id=e.organization_id ' +
        "WHERE e.organization_id=? AND e.event_type='filling_started' " +
        "AND COALESCE(CAST(json_extract(e.details,'$.accountId') AS INTEGER),j.social_account_id)=?",
    )
    .get(organizationId, accountId) as { lastClaim?: string | null }
  const finished = db
    .prepare(
      'SELECT MAX(updated_at) lastFinished FROM publication_jobs ' +
        "WHERE organization_id=? AND social_account_id=? AND status IN ('completed','removed')",
    )
    .get(organizationId, accountId) as { lastFinished?: string | null }
  const candidates = [
    parseSqliteTimestamp(row?.lastClaim),
    parseSqliteTimestamp(finished?.lastFinished),
  ].filter((value): value is number => value != null)
  return candidates.length ? Math.max(...candidates) : null
}

// A release is tied to a single failed claim, not to a profile-wide exemption.
function failedClaimForInterval(db: DatabaseSync, organizationId: number, accountId: number) {
  const claim = db
    .prepare(
      `SELECT e.id eventId,e.created_at claimedAt,j.id jobId,j.status,j.publish_attempt_at publishAttemptAt,j.fill_report fillReport,j.social_account_id currentAccountId
       FROM publication_job_events e JOIN publication_jobs j ON j.id=e.publication_job_id AND j.organization_id=e.organization_id
       WHERE e.organization_id=? AND e.event_type='filling_started'
       AND COALESCE(CAST(json_extract(e.details,'$.accountId') AS INTEGER),j.social_account_id)=?
       ORDER BY e.created_at DESC,e.id DESC LIMIT 1`,
    )
    .get(organizationId, accountId) as
    | { eventId: number; claimedAt: string; jobId: number; status: string; publishAttemptAt: string | null; fillReport: string | null; currentAccountId: number }
    | undefined
  if (!claim || claim.currentAccountId !== accountId || claim.status !== 'error' || publicationMayExist(claim))
    return null
  const finished = db
    .prepare(
      "SELECT 1 FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND status IN ('completed','removed') AND datetime(updated_at)>=datetime(?) LIMIT 1",
    )
    .get(organizationId, accountId, claim.claimedAt)
  const active = db
    .prepare(
      "SELECT 1 FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND status='filling' AND datetime(lease_expires_at)>CURRENT_TIMESTAMP LIMIT 1",
    )
    .get(organizationId, accountId)
  if (finished || active) return null
  const release = db
    .prepare(
      `SELECT 1 FROM publication_job_events WHERE organization_id=? AND publication_job_id=?
       AND event_type='failed_interval_released' AND CAST(json_extract(details,'$.claimEventId') AS INTEGER)=?
       AND CAST(json_extract(details,'$.accountId') AS INTEGER)=? LIMIT 1`,
    )
    .get(organizationId, claim.jobId, claim.eventId, accountId)
  return { ...claim, released: Boolean(release) }
}

export function profileCapacity(
  db: DatabaseSync,
  organizationId: number,
  accountId: number,
  now = Date.now(),
) {
  const limits = profileLimits(db, organizationId, accountId)
  const used = dailyExecutionAttempts(db, organizationId, accountId)
  const queuedRow = db
    .prepare(
      'SELECT COUNT(*) queued FROM publication_jobs WHERE organization_id=? AND social_account_id=? ' +
        "AND autoflow_day(created_at)=autoflow_day(CURRENT_TIMESTAMP) AND status!='canceled'",
    )
    .get(organizationId, accountId) as { queued: number }
  const lastActivityAt = lastProfileActivityAt(db, organizationId, accountId)
  const storedCooldown = db
    .prepare(
      'SELECT next_publication_allowed_at nextAllowedAt FROM social_accounts WHERE organization_id=? AND id=?',
    )
    .get(organizationId, accountId) as { nextAllowedAt: string | null } | undefined
  const cooldownAt = parseSqliteTimestamp(storedCooldown?.nextAllowedAt)
  const failedClaim = failedClaimForInterval(db, organizationId, accountId)
  const released = Boolean(failedClaim?.released)
  const regularAt =
    lastActivityAt == null || released ? null : lastActivityAt + limits.intervalMinutes * 60000
  const nextAllowedTime = Math.max(regularAt || 0, cooldownAt || 0) || null
  const retryAfterSeconds =
    nextAllowedTime != null && nextAllowedTime > now ? Math.ceil((nextAllowedTime - now) / 1000) : 0
  return {
    ...limits,
    used,
    remaining: Math.max(0, limits.dailyLimit - used),
    queuedToday: Number(queuedRow.queued),
    lastActivityAt: lastActivityAt == null ? null : new Date(lastActivityAt).toISOString(),
    nextAllowedAt: retryAfterSeconds ? new Date(nextAllowedTime!).toISOString() : null,
    retryAfterSeconds,
    blockedByDailyLimit: used >= limits.dailyLimit,
    canReleaseFailedInterval: Boolean(
      failedClaim &&
        !released &&
        retryAfterSeconds > 0 &&
        used < limits.dailyLimit &&
        (cooldownAt == null || cooldownAt <= now),
    ),
    failedIntervalReleased: released,
    publicationCooldownUntil: cooldownAt != null && cooldownAt > now ? new Date(cooldownAt).toISOString() : null,
  }
}

// No changes to the daily counter, post-publication cooldown, lease or job status.
export function releaseFailedExecutionInterval(
  db: DatabaseSync,
  organizationId: number,
  accountId: number,
  actorId: number,
) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const capacity = profileCapacity(db, organizationId, accountId)
    const claim = failedClaimForInterval(db, organizationId, accountId)
    if (!capacity.canReleaseFailedInterval || !claim || claim.released) {
      db.exec('COMMIT')
      return null
    }
    db.prepare(
      `INSERT INTO publication_job_events
       (organization_id,publication_job_id,event_type,created_by,details)
       VALUES (?,?,'failed_interval_released',?,?)`,
    ).run(organizationId, claim.jobId, actorId, JSON.stringify({
      claimEventId: claim.eventId,
      accountId,
      previousNextAllowedAt: capacity.nextAllowedAt,
      reason: 'manual_retry_after_failed_fill',
    }))
    const result = profileCapacity(db, organizationId, accountId)
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
