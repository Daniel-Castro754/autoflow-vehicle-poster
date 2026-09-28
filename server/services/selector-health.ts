import type { DatabaseSync } from 'node:sqlite'

export type SelectorHealthReport = {
  configVersion: string
  pageLocale: string
  criticalTotal: number
  missingCount: number
  successRate: number
  severe: boolean
  missingFields: string[]
}

export function sanitizeSelectorHealth(
  value: unknown,
  fallbackMissingFields: string[] = [],
): SelectorHealthReport {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const criticalTotal = Math.max(0, Math.min(100, Math.trunc(Number(raw.criticalTotal) || 0)))
  const missingFields = fallbackMissingFields.map(String).slice(0, 30)
  const missingCount = Math.max(
    missingFields.length,
    Math.max(0, Math.min(criticalTotal || 100, Math.trunc(Number(raw.missingCount) || 0))),
  )
  const providedRate = Number(raw.successRate)
  const computedRate =
    criticalTotal > 0 ? Math.max(0, Math.min(1, (criticalTotal - missingCount) / criticalTotal)) : 1
  return {
    configVersion: String(raw.configVersion || '')
      .trim()
      .slice(0, 50),
    pageLocale: String(raw.pageLocale || '')
      .trim()
      .slice(0, 20),
    criticalTotal,
    missingCount,
    successRate: Number.isFinite(providedRate)
      ? Math.max(0, Math.min(1, providedRate))
      : computedRate,
    severe:
      raw.severe === true ||
      missingCount >= 3 ||
      (criticalTotal > 0 && missingCount >= 2 && missingCount / criticalTotal >= 0.3),
    missingFields,
  }
}

export function recordSelectorHealth(
  db: DatabaseSync,
  organizationId: number,
  accountId: number,
  jobId: number,
  health: SelectorHealthReport,
) {
  db.prepare(
    `INSERT INTO selector_health_events (
      organization_id,social_account_id,publication_job_id,selector_config_version,page_locale,
      critical_total,missing_count,success_rate,missing_fields,severe
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    organizationId,
    accountId,
    jobId,
    health.configVersion,
    health.pageLocale,
    health.criticalTotal,
    health.missingCount,
    health.successRate,
    JSON.stringify(health.missingFields),
    health.severe ? 1 : 0,
  )
}

export function openSelectorCircuitBreaker(
  db: DatabaseSync,
  organizationId: number,
  accountId: number,
  jobId: number,
  missingFields: string[],
) {
  const reason =
    `Possível mudança no formulário do Facebook: ${missingFields.join(', ') || 'vários campos críticos não foram encontrados'}.`.slice(
      0,
      500,
    )
  db.prepare(
    `UPDATE social_accounts
      SET automation_paused=1,automation_pause_reason=?,automation_paused_at=CURRENT_TIMESTAMP
      WHERE id=? AND organization_id=?`,
  ).run(reason, accountId, organizationId)
  void jobId
  return { reason }
}

export function closeSelectorCircuitBreaker(
  db: DatabaseSync,
  organizationId: number,
  accountId: number,
) {
  db.prepare(
    `UPDATE social_accounts
      SET automation_paused=0,automation_pause_reason='',automation_paused_at=NULL
      WHERE id=? AND organization_id=?`,
  ).run(accountId, organizationId)
  return true
}
