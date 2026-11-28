import type { DatabaseSync } from 'node:sqlite'
import { runAutopilotPipeline } from './ai-agent.ts'
import { logger } from '../lib/logger.ts'

// Keep AI provider/network pressure bounded while allowing independent tenants to progress.
// Per-tenant exclusivity is enforced by the persisted coordinator lease.
export function boundedAutopilotConcurrency(value: unknown): number {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 ? Math.min(number, 4) : 3
}

export function createAutonomousScheduler(
  db: DatabaseSync,
  {
    intervalMs = 30_000,
    run = runAutopilotPipeline,
    maxConcurrentOrganizations = boundedAutopilotConcurrency(
      process.env.AUTOPILOT_MAX_PARALLEL_ORGS || 3,
    ),
  } = {},
) {
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false
  let stopped = false
  let generation = 0
  let restartPending = false
  async function sweep() {
    if (running || stopped) return
    running = true
    const sweepGeneration = generation
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
      // Fixed-size pool: a slow AI request in one tenant must not stall all others.
      // No whole-pipeline automatic retry here: a failed run might already have created jobs.
      // A queued tenant may be disabled, rescheduled or claimed by another
      // process while waiting behind a slow tenant. The coordinator still
      // owns the final transactional claim; this is an early revalidation.
      const due = db.prepare(
        `SELECT 1 FROM organization_settings s
        LEFT JOIN autopilot_state a ON a.organization_id=s.organization_id
        WHERE s.organization_id=? AND s.autopilot_enabled=1
        AND (a.next_run_at IS NULL OR datetime(a.next_run_at)<=CURRENT_TIMESTAMP)
        AND (a.lease_expires_at IS NULL OR datetime(a.lease_expires_at)<=CURRENT_TIMESTAMP)`,
      )
      let nextIndex = 0
      const work = async () => {
        while (!stopped && sweepGeneration === generation) {
          const org = organizations[nextIndex++]
          if (!org) break
          try {
            if (!due.get(org.id)) continue
            await run(db, org.id, null, { automatic: true })
          } catch (error) {
            logger.error('AutonomousScheduler', 'Falha na rodada de agendamento', {
              organizationId: org.id,
              error,
            })
          }
        }
      }
      const parallelism = Math.min(
        organizations.length,
        boundedAutopilotConcurrency(maxConcurrentOrganizations),
      )
      await Promise.all(Array.from({ length: parallelism }, () => work()))
    } catch (error) {
      logger.error('AutonomousScheduler', 'Falha na consulta de organizações', { error })
    } finally {
      running = false
      // If start() followed stop() during an in-flight run, discard the old
      // snapshot and immediately perform one fresh sweep after it drains.
      if (restartPending && !stopped) {
        restartPending = false
        void sweep()
      }
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
      if (running) restartPending = true
      else void sweep()
    },
    stop() {
      stopped = true
      generation++
      restartPending = false
      clearInterval(timer)
      timer = undefined
    },
  }
}
