import type { DatabaseSync } from 'node:sqlite'
import type { HistoricalEngagement } from './smart-scheduler.ts'
import { localParts, SCHEDULE_TIMEZONE } from '../lib/timezone.ts'

export function organizationScheduleHistory(
  db: DatabaseSync,
  organizationId: number,
  timezone = SCHEDULE_TIMEZONE,
): HistoricalEngagement[] {
  // Use started_at for the *attempted* time, not filled_at (which is completion
  // time). Only terminal completed/error jobs enter the denominator. Pending,
  // interrupted and uncertain outcomes cannot be counted as reliable failures.
  // Aggregate UTC hours first, then use the configured local business timezone.
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:00:00Z',started_at) instant,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) successCount,
      COUNT(*) attemptCount
    FROM publication_jobs WHERE organization_id=? AND status IN ('completed','error')
      AND started_at IS NOT NULL AND datetime(started_at)>=datetime('now','-180 days')
    GROUP BY instant`,
    )
    .all(organizationId) as Array<{ instant: string; successCount: number; attemptCount: number }>
  const buckets = new Map<string, HistoricalEngagement>()
  for (const row of rows) {
    const p = localParts(new Date(row.instant), timezone)
    const dayOfWeek = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
    const key = `${dayOfWeek}:${p.hour}`
    const bucket = buckets.get(key) || { dayOfWeek, hour: p.hour, successCount: 0, attemptCount: 0 }
    bucket.successCount += row.successCount
    bucket.attemptCount! += row.attemptCount
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
}
