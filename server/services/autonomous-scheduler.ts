import type { DatabaseSync } from 'node:sqlite'
import { runAutopilotPipeline } from './ai-agent.ts'
import { logger } from '../lib/logger.ts'

export function createAutonomousScheduler(
  db: DatabaseSync,
  { intervalMs = 30_000, run = runAutopilotPipeline } = {},
) {
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false
  let stopped = false
  async function sweep() {
    if (running || stopped) return
    running = true
    try {
      const organizations = db
        .prepare(
          `SELECT s.organization_id id FROM organization_settings s
        LEFT JOIN autopilot_state a ON a.organization_id=s.organization_id
        WHERE s.autopilot_enabled=1 AND (a.next_run_at IS NULL OR datetime(a.next_run_at)<=CURRENT_TIMESTAMP)
        AND (a.lease_expires_at IS NULL OR datetime(a.lease_expires_at)<=CURRENT_TIMESTAMP)
        ORDER BY COALESCE(a.next_run_at,'') ASC,s.organization_id`,
        )
        .all() as Array<{ id: number }>
      for (const org of organizations) {
        if (stopped) break
        try {
          await run(db, org.id, null, { automatic: true })
        } catch (error) {
          logger.error('AutonomousScheduler', 'Falha na rodada de agendamento', {
            organizationId: org.id,
            error,
          })
        }
      }
    } catch (error) {
      logger.error('AutonomousScheduler', 'Falha na consulta de organizações', { error })
    } finally {
      running = false
    }
  }
  return {
    sweep,
    start() {
      if (timer) return
      stopped = false
      timer = setInterval(() => {
        void sweep()
      }, intervalMs)
      timer.unref()
      void sweep()
    },
    stop() {
      stopped = true
      clearInterval(timer)
      timer = undefined
    },
  }
}
