import type { DatabaseSync } from 'node:sqlite'

export function operationalHealth(db: DatabaseSync, organizationId: number) {
  const jobs = db
    .prepare(
      `SELECT COUNT(*) total,
    COALESCE(SUM(status='pending'),0) pending,COALESCE(SUM(status='filling'),0) active,
    COALESCE(SUM(status='awaiting_confirmation'),0) awaitingConfirmation,
    COALESCE(SUM(status='error'),0) errors
    FROM publication_jobs WHERE organization_id=?`,
    )
    .get(organizationId) as {
    total: number
    pending: number
    active: number
    awaitingConfirmation: number
    errors: number
  }
  const health = db
    .prepare(
      `SELECT
    COALESCE(SUM(j.status='error' AND datetime(j.updated_at)>=datetime('now','-2 hours')),0) recentErrorsCount,
    COALESCE(SUM(j.status='filling' AND j.lease_expires_at IS NOT NULL AND datetime(j.lease_expires_at)<=CURRENT_TIMESTAMP),0) expiredLeasesCount,
    COALESCE(SUM(j.status='filling' AND (j.lease_expires_at IS NULL OR datetime(j.lease_expires_at)<=CURRENT_TIMESTAMP)
      AND unixepoch('now')-unixepoch(j.started_at)>=COALESCE(s.stuck_timeout_minutes,15)*60),0) stuckJobsCount,
    COALESCE(SUM(j.status='filling' AND datetime(j.lease_expires_at)>CURRENT_TIMESTAMP
      AND unixepoch('now')-unixepoch(j.started_at)>=COALESCE(s.stuck_timeout_minutes,15)*45),0) slowJobsCount
    FROM publication_jobs j LEFT JOIN organization_settings s ON s.organization_id=j.organization_id
    WHERE j.organization_id=?`,
    )
    .get(organizationId) as {
    recentErrorsCount: number
    expiredLeasesCount: number
    stuckJobsCount: number
    slowJobsCount: number
  }
  const events = db
    .prepare(
      `SELECT COALESCE(SUM(event_type='stalled_recovered'),0) recoveredCount,
    COALESCE(SUM(event_type='job_nearly_stuck'),0) warningCount
    FROM publication_job_events WHERE organization_id=? AND created_at>=datetime('now','-1 day')`,
    )
    .get(organizationId) as { recoveredCount: number; warningCount: number }
  const performance = db
    .prepare(
      `SELECT
    COALESCE(SUM(status IN ('completed','removed') AND datetime(filled_at)>=datetime('now','-1 day')),0) completed,
    COALESCE(SUM(status='error' AND datetime(updated_at)>=datetime('now','-1 day')),0) errors,
    AVG(CASE WHEN status IN ('completed','removed') AND datetime(filled_at)>=datetime('now','-1 day')
      AND unixepoch(filled_at)>=unixepoch(started_at) THEN unixepoch(filled_at)-unixepoch(started_at) END) averageDurationSeconds
    FROM publication_jobs WHERE organization_id=?`,
    )
    .get(organizationId) as {
    completed: number
    errors: number
    averageDurationSeconds: number | null
  }
  const accounts = db
    .prepare(
      `SELECT a.id,a.label,a.status,a.automation_paused automationPaused,
    a.automation_pause_reason automationPauseReason,a.automation_paused_at automationPausedAt,
    COALESCE(SUM(j.status IN ('completed','removed') AND datetime(j.filled_at)>=datetime('now','-1 day')),0) completed,
    COALESCE(SUM(j.status='error' AND datetime(j.updated_at)>=datetime('now','-1 day')),0) errors,
    AVG(CASE WHEN j.status IN ('completed','removed') AND datetime(j.filled_at)>=datetime('now','-1 day')
      AND unixepoch(j.filled_at)>=unixepoch(j.started_at) THEN unixepoch(j.filled_at)-unixepoch(j.started_at) END) averageDurationSeconds
    FROM social_accounts a LEFT JOIN publication_jobs j ON j.organization_id=a.organization_id AND j.social_account_id=a.id
    WHERE a.organization_id=? GROUP BY a.id ORDER BY a.label,a.id`,
    )
    .all(organizationId) as Array<{
    id: number
    label: string
    status: string
    completed: number
    errors: number
    automationPaused: number
    automationPauseReason?: string
    automationPausedAt?: string
    averageDurationSeconds: number | null
  }>
  const selectorSummary = db
    .prepare(
      `SELECT COUNT(*) checks,
      COALESCE(SUM(severe=1),0) severe,
      COALESCE(AVG(success_rate),1) averageSuccessRate
      FROM selector_health_events
      WHERE organization_id=? AND datetime(created_at)>=datetime('now','-1 day')`,
    )
    .get(organizationId) as {
    checks: number
    severe: number
    averageSuccessRate: number
  }
  const selectorAccounts = db
    .prepare(
      `SELECT social_account_id accountId,COUNT(*) checks,
      COALESCE(SUM(severe=1),0) severe,COALESCE(AVG(success_rate),1) averageSuccessRate
      FROM selector_health_events
      WHERE organization_id=? AND datetime(created_at)>=datetime('now','-1 day')
      GROUP BY social_account_id`,
    )
    .all(organizationId) as Array<{
    accountId: number
    checks: number
    severe: number
    averageSuccessRate: number
  }>
  const selectorByAccount = new Map(selectorAccounts.map((item) => [item.accountId, item]))
  const selectorFieldRows = db
    .prepare(
      `SELECT missing_fields missingFields FROM selector_health_events
      WHERE organization_id=? AND datetime(created_at)>=datetime('now','-1 day') AND missing_count>0`,
    )
    .all(organizationId) as Array<{ missingFields: string }>
  const fieldFailures = new Map<string, number>()
  for (const row of selectorFieldRows) {
    try {
      const fields = JSON.parse(row.missingFields || '[]')
      if (Array.isArray(fields))
        for (const field of fields)
          fieldFailures.set(String(field), (fieldFailures.get(String(field)) || 0) + 1)
    } catch {
      // Ignore legacy/invalid diagnostic rows.
    }
  }
  const sellers = db
    .prepare(
      `SELECT u.id,u.name,
      COALESCE(SUM(j.status IN ('completed','removed') AND datetime(j.filled_at)>=datetime('now','-1 day')),0) completed,
      COALESCE(SUM(j.status='error' AND datetime(j.updated_at)>=datetime('now','-1 day')),0) errors,
      AVG(CASE WHEN j.status IN ('completed','removed') AND datetime(j.filled_at)>=datetime('now','-1 day')
        AND unixepoch(j.filled_at)>=unixepoch(j.started_at) THEN unixepoch(j.filled_at)-unixepoch(j.started_at) END) averageDurationSeconds
      FROM users u
      LEFT JOIN vehicles v ON v.organization_id=u.organization_id AND v.assigned_user_id=u.id
      LEFT JOIN publication_jobs j ON j.organization_id=u.organization_id AND j.vehicle_id=v.id
      WHERE u.organization_id=? GROUP BY u.id ORDER BY u.name`,
    )
    .all(organizationId)
  const autopilot = db
    .prepare(
      `SELECT s.autopilot_enabled enabled,s.autopilot_interval_minutes intervalMinutes,
    a.last_started_at lastStartedAt,a.last_finished_at lastFinishedAt,a.last_status lastStatus,
    COALESCE(a.last_jobs_created,0) lastJobsCreated,a.next_run_at nextRunAt,
    COALESCE(datetime(a.lease_expires_at)>CURRENT_TIMESTAMP,0) running
    FROM organization_settings s LEFT JOIN autopilot_state a ON a.organization_id=s.organization_id
    WHERE s.organization_id=?`,
    )
    .get(organizationId)
  return {
    timestamp: new Date().toISOString(),
    healthy:
      health.stuckJobsCount === 0 &&
      health.slowJobsCount === 0 &&
      health.expiredLeasesCount === 0 &&
      health.recentErrorsCount < 5 &&
      accounts.every((account) => !account.automationPaused),
    ...health,
    ...events,
    jobs,
    performance,
    selectorHealth: {
      ...selectorSummary,
      failingFields: [...fieldFailures.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([field, failures]) => ({ field, failures })),
    },
    accounts: accounts.map((account) => {
      const selector = selectorByAccount.get(account.id)
      return {
        ...account,
        successRate:
          account.completed + account.errors > 0
            ? account.completed / (account.completed + account.errors)
            : null,
        selectorChecks: selector?.checks || 0,
        selectorSevereFailures: selector?.severe || 0,
        selectorSuccessRate: selector?.averageSuccessRate ?? null,
      }
    }),
    sellers,
    autopilot,
  }
}

export function prometheusMetrics(report: ReturnType<typeof operationalHealth>): string {
  // Snapshots are gauges: removal, retry and retention can decrease the values.
  const metrics: Array<[string, string, number]> = [
    ['jobs', 'Jobs currently stored for this organization.', report.jobs.total],
    ['jobs_pending', 'Jobs waiting in the queue.', report.jobs.pending],
    ['jobs_active', 'Jobs currently filling.', report.jobs.active],
    [
      'jobs_awaiting_confirmation',
      'Jobs awaiting publication reconciliation.',
      report.jobs.awaitingConfirmation,
    ],
    ['jobs_stuck', 'Jobs past timeout with no live lease.', report.stuckJobsCount],
    ['jobs_slow', 'Live jobs past 75 percent of the configured timeout.', report.slowJobsCount],
    [
      'jobs_completed_24h',
      'Currently completed or removed jobs filled in the last 24 hours.',
      report.performance.completed,
    ],
    [
      'jobs_error_24h',
      'Currently failed jobs updated in the last 24 hours.',
      report.performance.errors,
    ],
    ['jobs_recovered_24h', 'Recovery events in the last 24 hours.', report.recoveredCount],
    ['warnings_24h', 'Slow execution warnings recorded in the last 24 hours.', report.warningCount],
    [
      'accounts_connected',
      'Connected accounts.',
      report.accounts.filter((account) => account.status === 'connected').length,
    ],
    [
      'accounts_automation_paused',
      'Accounts paused by the selector circuit breaker or an administrator.',
      report.accounts.filter((account) => account.automationPaused).length,
    ],
    [
      'selector_checks_24h',
      'Selector health reports received in the last 24 hours.',
      report.selectorHealth.checks,
    ],
    [
      'selector_severe_failures_24h',
      'Severe selector-layout failures received in the last 24 hours.',
      report.selectorHealth.severe,
    ],
  ]
  if (report.performance.averageDurationSeconds !== null)
    metrics.push([
      'publication_duration_seconds_24h',
      'Mean start-to-fill duration for completed jobs filled in the last 24 hours.',
      report.performance.averageDurationSeconds,
    ])
  return metrics
    .map(
      ([name, help, value]) =>
        `# HELP autoflow_${name} ${help}\n# TYPE autoflow_${name} gauge\nautoflow_${name} ${value}\n`,
    )
    .join('')
}
