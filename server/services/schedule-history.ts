import type { DatabaseSync } from 'node:sqlite'
import type { HistoricalEngagement } from './smart-scheduler.ts'

export function organizationScheduleHistory(db: DatabaseSync, organizationId:number):HistoricalEngagement[] {
  return db.prepare(`SELECT CAST(strftime('%w',filled_at) AS INTEGER) dayOfWeek,CAST(strftime('%H',filled_at) AS INTEGER) hour,COUNT(*) successCount
    FROM publication_jobs WHERE organization_id=? AND status='completed' AND filled_at IS NOT NULL
      AND datetime(filled_at)>=datetime('now','-180 days')
    GROUP BY dayOfWeek,hour`).all(organizationId) as unknown as HistoricalEngagement[]
}
