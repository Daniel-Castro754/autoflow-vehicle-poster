import { organizationScheduleHistory } from '../services/schedule-history.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { calculateOptimalSchedule } from '../services/smart-scheduler.ts'

type AuthContext = { userId: number; organizationId: number }
type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  jsonBody: (req: IncomingMessage) => Promise<unknown>
  canManageJobs: (ids: number[], auth: AuthContext) => boolean
  recordJobEvent: (
    organizationId: number,
    publicationJobId: number,
    eventType: string,
    createdBy?: number | null,
    details?: Record<string, unknown>,
  ) => void
}

export async function handlePublicationSchedulingRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext,
  { db, send, jsonBody, canManageJobs, recordJobEvent }: Dependencies,
): Promise<boolean> {
  const singleSchedule = url.pathname.match(/^\/api\/publications\/(\d+)\/smart-schedule$/)
  if (req.method === 'POST' && singleSchedule) {
    const jobId = Number(singleSchedule[1])
    const job = db
      .prepare(
        `SELECT j.id, j.status, j.social_account_id accountId, v.vehicle_type vehicleType
      FROM publication_jobs j JOIN vehicles v ON v.id = j.vehicle_id
      WHERE j.id = ? AND j.organization_id = ?`,
      )
      .get(jobId, auth.organizationId) as
      { id: number; status: string; accountId: number } | undefined
    if (!job) {
      send(res, 404, { error: 'Trabalho não encontrado.' })
      return true
    }
    if (!canManageJobs([job.id], auth)) {
      send(res, 403, { error: 'Você não pode alterar trabalhos de outro perfil.' })
      return true
    }
    if (!['pending', 'error', 'awaiting_confirmation'].includes(job.status)) {
      send(res, 409, { error: 'Este trabalho não pode ser agendado agora.' })
      return true
    }

    const existing = db
      .prepare(
        `SELECT scheduled_at scheduledAt FROM publication_jobs
      WHERE organization_id = ? AND social_account_id = ? AND id != ? AND scheduled_at IS NOT NULL
        AND datetime(scheduled_at) > CURRENT_TIMESTAMP`,
      )
      .all(auth.organizationId, job.accountId, job.id) as Array<{ scheduledAt: string }>
    const existingTimestamps = existing
      .map((item) => Date.parse(item.scheduledAt))
      .filter(Number.isFinite)
    const optimal = calculateOptimalSchedule({
      existingTimestamps,
      accountId: job.accountId,
      historicalData: organizationScheduleHistory(db, auth.organizationId),
    })

    db.prepare(
      'UPDATE publication_jobs SET scheduled_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?',
    ).run(optimal.isoString, job.id, auth.organizationId)
    recordJobEvent(auth.organizationId, job.id, 'smart_scheduled', auth.userId, {
      scheduledAt: optimal.isoString,
      window: optimal.window,
      confidence: optimal.confidence,
      jitterMinutes: optimal.jitterMinutes,
    })
    send(res, 200, {
      ok: true,
      scheduledAt: optimal.isoString,
      window: optimal.window,
      confidence: optimal.confidence,
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/publications/smart-schedule-batch') {
    return scheduleBatch(req, res, auth, { db, send, jsonBody, canManageJobs, recordJobEvent })
  }

  return false
}

async function scheduleBatch(
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthContext,
  { db, send, jsonBody, canManageJobs, recordJobEvent }: Dependencies,
): Promise<boolean> {
  const body = (await jsonBody(req)) as Record<string, unknown>
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.map(Number).filter(Number.isInteger))].slice(0, 50)
    : []
  if (ids.length < 1) {
    send(res, 400, { error: 'Selecione pelo menos um trabalho para agendamento inteligente.' })
    return true
  }
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT id, status, social_account_id accountId FROM publication_jobs WHERE organization_id = ? AND id IN (${placeholders})`,
    )
    .all(auth.organizationId, ...ids) as Array<{ id: number; status: string; accountId: number }>
  if (rows.length !== ids.length) {
    send(res, 400, { error: 'Um ou mais trabalhos não pertencem a esta empresa.' })
    return true
  }
  if (!canManageJobs(ids, auth)) {
    send(res, 403, { error: 'Você não pode alterar trabalhos de outro perfil.' })
    return true
  }
  if (rows.some((job) => !['pending', 'error', 'awaiting_confirmation'].includes(job.status))) {
    send(res, 409, { error: 'Trabalhos em preenchimento ou encerrados não podem ser agendados.' })
    return true
  }

  const byId = new Map(rows.map((job) => [job.id, job]))
  const existing = db
    .prepare(
      `SELECT social_account_id accountId, scheduled_at scheduledAt FROM publication_jobs WHERE organization_id = ? AND scheduled_at IS NOT NULL
    AND datetime(scheduled_at) > CURRENT_TIMESTAMP AND id NOT IN (${placeholders}) AND status IN ('pending', 'error', 'awaiting_confirmation')`,
    )
    .all(auth.organizationId, ...ids) as Array<{ accountId: number; scheduledAt: string }>

  const occupied = new Map<number, number[]>()
  for (const item of existing) {
    const timestamp = Date.parse(item.scheduledAt)
    if (Number.isFinite(timestamp))
      occupied.set(item.accountId, [...(occupied.get(item.accountId) || []), timestamp])
  }

  const assignments = ids.map((id) => {
    const job = byId.get(id)!
    const profileTimes = occupied.get(job.accountId) || []
    const optimal = calculateOptimalSchedule({
      existingTimestamps: profileTimes,
      accountId: job.accountId,
      historicalData: organizationScheduleHistory(db, auth.organizationId),
    })
    profileTimes.push(optimal.scheduledAt.getTime())
    occupied.set(job.accountId, profileTimes)
    return { id, accountId: job.accountId, scheduledAt: optimal.isoString, window: optimal.window }
  })

  db.exec('BEGIN')
  try {
    for (const assignment of assignments) {
      db.prepare(
        'UPDATE publication_jobs SET scheduled_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?',
      ).run(assignment.scheduledAt, assignment.id, auth.organizationId)
      recordJobEvent(auth.organizationId, assignment.id, 'smart_scheduled', auth.userId, {
        scheduledAt: assignment.scheduledAt,
        window: assignment.window,
        batch: true,
      })
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  send(res, 200, { ok: true, updated: assignments.length, assignments })
  return true
}
