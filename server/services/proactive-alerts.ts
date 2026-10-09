import type { DatabaseSync } from 'node:sqlite'
import { sendCriticalAlert } from './alerting.ts'
import { logger } from '../lib/logger.ts'
import { recordOperationalSignal } from './operational-incidents.ts'

export async function warnSlowExecutions(
  db: DatabaseSync,
  sendAlert = sendCriticalAlert,
): Promise<number> {
  const jobs = db
    .prepare(
      `SELECT j.id,j.organization_id organizationId,j.attempt_count attemptCount,
    j.started_at startedAt,a.label accountLabel,s.stuck_timeout_minutes timeoutMinutes,
    (unixepoch('now')-unixepoch(j.started_at))/60.0 elapsedMinutes,
    s.alert_telegram_token telegramBotToken,s.alert_telegram_chat_id telegramChatId,s.alert_webhook_url webhookUrl
    FROM publication_jobs j JOIN organization_settings s ON s.organization_id=j.organization_id
    LEFT JOIN social_accounts a ON a.id=j.social_account_id AND a.organization_id=j.organization_id
    WHERE j.status='filling' AND datetime(j.lease_expires_at)>CURRENT_TIMESTAMP
      AND unixepoch('now')-unixepoch(j.started_at)>=s.stuck_timeout_minutes*45
      AND j.near_timeout_alert_attempt!=j.attempt_count ORDER BY j.started_at,j.id LIMIT 10`,
    )
    .all() as Array<{
    id: number
    organizationId: number
    attemptCount: number
    startedAt: string
    accountLabel: string | null
    timeoutMinutes: number
    elapsedMinutes: number
    telegramBotToken: string
    telegramChatId: string
    webhookUrl: string
  }>
  const deliveries: Promise<void>[] = []
  let warnings = 0
  for (const job of jobs) {
    // Commit before delivery: at most one warning per attempt, even across restarts/processes.
    db.exec('BEGIN IMMEDIATE')
    let eventId: number
    try {
      const claimed = db
        .prepare(
          `UPDATE publication_jobs SET near_timeout_alert_attempt=attempt_count
        WHERE id=? AND organization_id=? AND status='filling' AND attempt_count=? AND started_at=?
          AND datetime(lease_expires_at)>CURRENT_TIMESTAMP AND near_timeout_alert_attempt!=attempt_count`,
        )
        .run(job.id, job.organizationId, job.attemptCount, job.startedAt)
      if (!claimed.changes) {
        db.exec('COMMIT')
        continue
      }
      eventId = Number(
        db
          .prepare(
            `INSERT INTO publication_job_events (organization_id,publication_job_id,event_type,details)
        VALUES (?,?,'job_nearly_stuck',?)`,
          )
          .run(
            job.organizationId,
            job.id,
            JSON.stringify({
              attemptCount: job.attemptCount,
              elapsedMinutes: job.elapsedMinutes,
              timeoutMinutes: job.timeoutMinutes,
            }),
          ).lastInsertRowid,
      )
      recordOperationalSignal(db, job.organizationId, job.id, 'job_nearly_stuck')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    warnings++
    const deliveryTask = sendAlert(
      {
        jobId: job.id,
        type: 'job_nearly_stuck',
        severity: 'warning',
        accountLabel: job.accountLabel || 'Perfil não definido',
        attemptCount: job.attemptCount,
        message: `Preenchimento em execução há ${Math.round(job.elapsedMinutes)} min (limite configurado: ${job.timeoutMinutes} min). A execução continua ativa.`,
      },
      job,
    )
      .then((delivery) => {
        db.prepare(
          `UPDATE publication_job_events SET details=json_set(details,'$.delivery',json(?)) WHERE id=? AND organization_id=?`,
        ).run(JSON.stringify(delivery), eventId, job.organizationId)
      })
      .catch((error) => {
        logger.warn('HealthMonitor', 'Falha ao entregar aviso de demora', { jobId: job.id, error })
      })
    deliveries.push(deliveryTask)
  }
  await Promise.all(deliveries)
  return warnings
}
