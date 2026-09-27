import type { DatabaseSync } from 'node:sqlite'
import type { HistoricalEngagement } from './smart-scheduler.ts'
import { localParts, SCHEDULE_TIMEZONE } from '../lib/timezone.ts'

export function organizationScheduleHistory(db: DatabaseSync, organizationId: number, timezone = SCHEDULE_TIMEZONE): HistoricalEngagement[] {
  // Aggregate UTC hours first to bound the rows transferred, then bucket in the same zone as the scheduler.
  const rows = db.prepare(`SELECT strftime('%Y-%m-%dT%H:00:00Z',filled_at) instant,COUNT(*) successCount
    FROM publication_jobs WHERE organization_id=? AND status='completed' AND filled_at IS NOT NULL
      AND datetime(filled_at)>=datetime('now','-180 days')
    GROUP BY instant`).all(organizationId) as Array<{instant: string; successCount: number}>
  const buckets = new Map<string, HistoricalEngagement>()
  for (const row of rows) {
    const p = localParts(new Date(row.instant), timezone)
    const dayOfWeek = new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay()
    const key = `${dayOfWeek}:${p.hour}`
    const bucket = buckets.get(key) || {dayOfWeek, hour:p.hour, successCount:0}
    bucket.successCount += row.successCount
    buckets.set(key,bucket)
  }
  return [...buckets.values()]
}
