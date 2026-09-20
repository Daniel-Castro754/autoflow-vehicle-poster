import type { DatabaseSync } from 'node:sqlite'
import { sendCriticalAlert } from './alerting.ts'

export interface HealthStatusReport {
  timestamp: string
  healthy: boolean
  stuckJobsCount: number
  expiredLeasesCount: number
  recentErrorsCount: number
  recoveredCount: number
}

let monitorTimer: NodeJS.Timeout | null = null

export async function runHealthCheck(
  db: DatabaseSync,
  options: { autoRecover?: boolean } = { autoRecover: true }
): Promise<HealthStatusReport> {
  const timestamp = new Date().toISOString()
  let recoveredCount = 0

  // 1. Identificar trabalhos travados em 'filling' com lease expirado além do timeout
  const stuckRows = db
    .prepare(`
      SELECT j.id, j.organization_id organizationId, j.social_account_id accountId, j.started_at startedAt,
        COALESCE(s.stuck_timeout_minutes, 15) timeoutMinutes,
        COALESCE(a.label, 'Sistema') accountLabel,
        v.year, v.make, v.model
      FROM publication_jobs j
      JOIN vehicles v ON v.id = j.vehicle_id
      LEFT JOIN social_accounts a ON a.id = j.social_account_id
      LEFT JOIN organization_settings s ON s.organization_id = j.organization_id
      WHERE j.status = 'filling'
        AND (j.lease_expires_at IS NULL OR datetime(j.lease_expires_at) <= CURRENT_TIMESTAMP)
        AND j.started_at IS NOT NULL
        AND (strftime('%s', 'now') - strftime('%s', j.started_at)) >= COALESCE(s.stuck_timeout_minutes, 15) * 60
    `)
    .all() as Array<{
      id: number
      organizationId: number
      accountId: number
      startedAt: string
      timeoutMinutes: number
      accountLabel: string
      year: number
      make: string
      model: string
    }>

  // 2. Identificar leases expirados que ficaram soltos
  const expiredLeases = db
    .prepare(`
      SELECT id, organization_id organizationId FROM publication_jobs
      WHERE status = 'filling' AND lease_expires_at IS NOT NULL
        AND datetime(lease_expires_at) <= CURRENT_TIMESTAMP
    `)
    .all() as Array<{ id: number; organizationId: number }>

  // 3. Auto-recuperação (Self-Healing) de jobs travados
  if (options.autoRecover && stuckRows.length > 0) {
    for (const job of stuckRows) {
      try {
        const elapsedMinutes = Math.max(
          1,
          Math.floor((Date.now() - new Date(job.startedAt.replace(' ', 'T') + 'Z').getTime()) / 60000)
        )

        db.exec('BEGIN')
        try {
          db.prepare(`
            UPDATE publication_jobs
            SET status = 'pending', paused = 0, extension_visible = 1, error_code = NULL,
              fill_report = '', started_at = NULL, filled_at = NULL, lease_token = NULL,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND organization_id = ?
          `).run(job.id, job.organizationId)

          db.prepare(`
            INSERT INTO publication_job_events (organization_id, publication_job_id, event_type, created_by, details)
            VALUES (?, ?, 'stalled_recovered', NULL, ?)
          `).run(
            job.organizationId,
            job.id,
            JSON.stringify({ elapsedMinutes, recoveredBy: 'health_monitor' })
          )

          db.exec('COMMIT')
          recoveredCount++
        } catch (txErr) {
          db.exec('ROLLBACK')
          console.warn(`[HealthMonitor] Falha ao recuperar job #${job.id}:`, txErr)
        }

        // Notifica via alerta caso o travamento tenha sido excessivo (> 30 min)
        if (elapsedMinutes >= 30) {
          void sendCriticalAlert({
            jobId: job.id,
            accountLabel: job.accountLabel,
            type: 'job_stalled_auto_recovered',
            message: `Trabalho travado há ${elapsedMinutes} min (${job.year} ${job.make} ${job.model}) foi recuperado automaticamente pelo Health Monitor.`,
            attemptCount: 1,
          })
        }
      } catch (err) {
        console.warn(`[HealthMonitor] Erro no processamento de job travado #${job.id}:`, err)
      }
    }
  }

  // 4. Contar erros recentes nas últimas 2 horas
  const recentErrors = db
    .prepare(`
      SELECT COUNT(*) count FROM publication_jobs
      WHERE status = 'error' AND datetime(updated_at) >= datetime('now', '-2 hours')
    `)
    .get() as { count?: number } | undefined

  const recentErrorsCount = Number(recentErrors?.count || 0)
  const healthy = stuckRows.length === 0 && recentErrorsCount < 5

  return {
    timestamp,
    healthy,
    stuckJobsCount: stuckRows.length,
    expiredLeasesCount: expiredLeases.length,
    recentErrorsCount,
    recoveredCount,
  }
}

export function startHealthMonitor(
  db: DatabaseSync,
  intervalMs = 60000
): void {
  if (monitorTimer) return

  monitorTimer = setInterval(async () => {
    try {
      await runHealthCheck(db, { autoRecover: true })
    } catch (err) {
      console.warn('[HealthMonitor] Erro na verificação periódica de saúde:', err)
    }
  }, intervalMs)

  // Evitar manter o processo do Node aberto apenas pelo monitor se em teste
  if (monitorTimer && typeof monitorTimer === 'object' && 'unref' in monitorTimer) {
    monitorTimer.unref()
  }
}

export function stopHealthMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer)
    monitorTimer = null
  }
}
