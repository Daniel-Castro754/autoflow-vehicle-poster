import type { DatabaseSync } from 'node:sqlite'

// Count executions actually claimed today, not jobs merely created/scheduled.
// Including retries conservatively prevents exceeding the daily execution budget.
// The claim and its filling_started event must be committed atomically.
export function dailyExecutionAttempts(db: DatabaseSync, organizationId: number, accountId: number) {
  const row = db.prepare(
    `SELECT COUNT(*) count
     FROM publication_job_events e
     JOIN publication_jobs j ON j.id=e.publication_job_id AND j.organization_id=e.organization_id
     WHERE e.organization_id=? AND e.event_type='filling_started'
       AND autoflow_day(e.created_at)=autoflow_day(CURRENT_TIMESTAMP)
       AND COALESCE(CAST(json_extract(e.details,'$.accountId') AS INTEGER),j.social_account_id)=?`,
  ).get(organizationId, accountId) as { count: number }
  return Number(row.count)
}
