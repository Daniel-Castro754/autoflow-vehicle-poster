import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AutopilotResult } from './ai-agent.ts'
import { logger } from '../lib/logger.ts'

export function skippedAutopilot(message: string): AutopilotResult {
  return {
    ok: true,
    processedCount: 0,
    jobsCreated: 0,
    descriptionsOptimized: 0,
    assignments: [],
    message,
  }
}

// Shared by manual commands and the worker, including separate API processes.
// The transaction only claims ownership; network calls never hold a SQLite transaction.
export async function coordinateAutopilot(
  db: DatabaseSync,
  organizationId: number,
  automatic: boolean,
  run: (ownsLease: () => boolean) => Promise<AutopilotResult>,
): Promise<AutopilotResult> {
  const owner = randomUUID()
  db.exec('BEGIN IMMEDIATE')
  try {
    const settings = db
      .prepare(
        `SELECT autopilot_enabled enabled FROM organization_settings WHERE organization_id=?`,
      )
      .get(organizationId) as { enabled: number } | undefined
    const state = db
      .prepare(
        `SELECT next_run_at IS NOT NULL AND datetime(next_run_at)>CURRENT_TIMESTAMP waiting FROM autopilot_state WHERE organization_id=?`,
      )
      .get(organizationId) as { waiting: number } | undefined
    if (!settings || (automatic && (!settings.enabled || state?.waiting))) {
      db.exec('COMMIT')
      return skippedAutopilot('Agendamento recorrente desligado ou aguardando a próxima rodada.')
    }
    const claimed = db
      .prepare(
        `INSERT INTO autopilot_state (organization_id,lease_owner,lease_expires_at,last_started_at,last_status)
      VALUES (?,?,datetime('now','+2 minutes'),CURRENT_TIMESTAMP,'running')
      ON CONFLICT(organization_id) DO UPDATE SET lease_owner=excluded.lease_owner,
        lease_expires_at=excluded.lease_expires_at,last_started_at=excluded.last_started_at,last_status='running'
      WHERE autopilot_state.lease_expires_at IS NULL OR datetime(autopilot_state.lease_expires_at)<=CURRENT_TIMESTAMP`,
      )
      .run(organizationId, owner)
    db.exec('COMMIT')
    if (!claimed.changes)
      return skippedAutopilot('O piloto automático desta organização já está em execução.')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  const ownsLease = () =>
    Boolean(
      db
        .prepare(
          `SELECT 1 FROM autopilot_state a JOIN organization_settings s ON s.organization_id=a.organization_id
    WHERE a.organization_id=? AND a.lease_owner=? AND datetime(a.lease_expires_at)>CURRENT_TIMESTAMP
      AND (?=0 OR s.autopilot_enabled=1)`,
        )
        .get(organizationId, owner, automatic ? 1 : 0),
    )
  const heartbeat = setInterval(() => {
    try {
      // An expired lease cannot be revived by a late timer.
      db.prepare(
        `UPDATE autopilot_state SET lease_expires_at=datetime('now','+2 minutes')
        WHERE organization_id=? AND lease_owner=? AND datetime(lease_expires_at)>CURRENT_TIMESTAMP`,
      ).run(organizationId, owner)
    } catch (error) {
      logger.warn('Autopilot', 'Falha ao renovar execução', { organizationId, error })
    }
  }, 20_000)
  heartbeat.unref()
  let status = 'error',
    jobsCreated = 0
  try {
    const result = await run(ownsLease)
    jobsCreated = result.jobsCreated
    status = result.ok ? (jobsCreated ? 'completed' : 'idle') : 'error'
    logger.info('Autopilot', 'Rodada concluída', { organizationId, automatic, jobsCreated, status })
    return result
  } finally {
    clearInterval(heartbeat)
    db.prepare(
      `UPDATE autopilot_state SET lease_owner=NULL,lease_expires_at=NULL,last_finished_at=CURRENT_TIMESTAMP,
      last_status=?,last_jobs_created=?,next_run_at=datetime('now','+' ||
        COALESCE((SELECT autopilot_interval_minutes FROM organization_settings WHERE organization_id=?),5) || ' minutes')
      WHERE organization_id=? AND lease_owner=?`,
    ).run(status, jobsCreated, organizationId, organizationId, owner)
  }
}
