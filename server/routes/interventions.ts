import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

type Auth = { userId: number; organizationId: number }
type Deps = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, body: unknown) => void
  jsonBody: (req: IncomingMessage) => Promise<unknown>
  isAdmin: (auth: Auth) => boolean
}

const listLimit = (raw: string | null) => {
  const number = Number(raw || 25)
  return Number.isInteger(number) && number > 0 ? Math.min(number, 100) : 25
}

export async function handleInterventionsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: Auth,
  { db, send, jsonBody, isAdmin }: Deps,
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/operations/')) return false
  if (!['/api/operations/incidents', '/api/operations/activity'].includes(url.pathname) &&
    !/^\/api\/operations\/incidents\/\d+(?:\/history)?$/.test(url.pathname))
    return false
  res.setHeader('Cache-Control', 'no-store')
  const organizationId = auth.organizationId

  if (req.method === 'GET' && url.pathname === '/api/operations/incidents') {
    const status = url.searchParams.get('status') || 'active'
    if (!['active', 'open', 'acknowledged', 'resolved', 'all'].includes(status)) {
      send(res, 400, { error: 'Filtro de situação inválido.' })
      return true
    }
    const scope = status === 'active' ? "AND i.status IN ('open','acknowledged')"
      : status === 'all' ? '' : 'AND i.status=?'
    const argumentsList: Array<number | string> = [organizationId]
    if (status !== 'active' && status !== 'all') argumentsList.push(status)
    const rows = db.prepare(
      `SELECT i.id,i.publication_job_id jobId,i.kind,i.severity,i.status,i.summary,
        i.occurrence_count occurrenceCount,i.first_seen_at firstSeenAt,i.last_seen_at lastSeenAt,
        i.acknowledged_at acknowledgedAt,i.resolved_at resolvedAt,
        j.status jobStatus,COALESCE(a.label,'Sem perfil') accountLabel,
        v.year || ' ' || v.make || ' ' || v.model vehicleTitle
      FROM operational_incidents i
      JOIN publication_jobs j ON j.id=i.publication_job_id AND j.organization_id=i.organization_id
      JOIN vehicles v ON v.id=j.vehicle_id AND v.organization_id=j.organization_id
      LEFT JOIN social_accounts a ON a.id=j.social_account_id AND a.organization_id=j.organization_id
      WHERE i.organization_id=? ${scope}
      ORDER BY CASE i.severity WHEN 'critical' THEN 0 ELSE 1 END,i.last_seen_at DESC,i.id DESC
      LIMIT ?`,
    ).all(...argumentsList, listLimit(url.searchParams.get('limit')))
    const totals = db.prepare(
      `SELECT COUNT(*) total,
        COALESCE(SUM(status='open'),0) open,
        COALESCE(SUM(status='acknowledged'),0) acknowledged,
        COALESCE(SUM(status='resolved'),0) resolved,
        COALESCE(SUM(status!='resolved' AND severity='critical'),0) critical
      FROM operational_incidents WHERE organization_id=?`,
    ).get(organizationId)
    send(res, 200, { incidents: rows, totals })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/operations/activity') {
    const rawJobId = url.searchParams.get('jobId')
    const rawBeforeId = url.searchParams.get('beforeId')
    const jobId = rawJobId ? Number(rawJobId) : 0
    const beforeId = rawBeforeId ? Number(rawBeforeId) : 0
    if (
      (rawJobId && (!Number.isSafeInteger(jobId) || jobId <= 0)) ||
      (rawBeforeId && (!Number.isSafeInteger(beforeId) || beforeId <= 0))
    ) {
      send(res, 400, { error: 'Identificador de histórico inválido.' })
      return true
    }
    const rows = db.prepare(
      `SELECT e.id,e.publication_job_id jobId,e.event_type eventType,e.created_at createdAt,
        COALESCE(a.label,'Sem perfil') accountLabel,
        v.year || ' ' || v.make || ' ' || v.model vehicleTitle
      FROM publication_job_events e
      JOIN publication_jobs j ON j.id=e.publication_job_id AND j.organization_id=e.organization_id
      JOIN vehicles v ON v.id=j.vehicle_id AND v.organization_id=j.organization_id
      LEFT JOIN social_accounts a ON a.id=j.social_account_id AND a.organization_id=j.organization_id
      WHERE e.organization_id=?
        AND (?=0 OR e.publication_job_id=?)
        AND (?=0 OR e.id<?)
      ORDER BY e.id DESC LIMIT ?`,
    ).all(organizationId, jobId, jobId, beforeId, beforeId, listLimit(url.searchParams.get('limit')))
    send(res, 200, { activity: rows })
    return true
  }

  const match = /^\/api\/operations\/incidents\/(\d+)(\/history)?$/.exec(url.pathname)
  if (!match) return false
  const incidentId = Number(match[1])
  if (!Number.isSafeInteger(incidentId) || incidentId <= 0) {
    send(res, 400, { error: 'Identificador inválido.' })
    return true
  }
  if (req.method === 'GET' && match[2] === '/history') {
    const exists = db.prepare(
      'SELECT 1 FROM operational_incidents WHERE id=? AND organization_id=?',
    ).get(incidentId, organizationId)
    if (!exists) {
      send(res, 404, { error: 'Ocorrência não encontrada.' })
      return true
    }
    const history = db.prepare(
      `SELECT a.id,a.action,a.note,a.created_at createdAt,u.name actorName
      FROM operational_incident_actions a
      LEFT JOIN users u ON u.id=a.actor_user_id AND u.organization_id=a.organization_id
      WHERE a.incident_id=? AND a.organization_id=?
      ORDER BY a.id DESC LIMIT 100`,
    ).all(incidentId, organizationId)
    send(res, 200, { history })
    return true
  }
  if (req.method !== 'PATCH' || match[2]) return false
  if (!isAdmin(auth)) {
    send(res, 403, { error: 'Somente administradores podem tratar ocorrências.' })
    return true
  }
  const body = (await jsonBody(req)) as Record<string, unknown> | null
  const action = body?.action
  if (action !== 'acknowledge' && action !== 'resolve') {
    send(res, 400, { error: 'Ação inválida. Use acknowledge ou resolve.' })
    return true
  }
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 240) : ''
  db.exec('BEGIN IMMEDIATE')
  try {
    const incident = db.prepare(
      `SELECT i.id,i.status,i.kind,j.status jobStatus
      FROM operational_incidents i JOIN publication_jobs j
        ON j.id=i.publication_job_id AND j.organization_id=i.organization_id
      WHERE i.id=? AND i.organization_id=?`,
    ).get(incidentId, organizationId) as
      | { id: number; status: string; kind: string; jobStatus: string }
      | undefined
    if (!incident) {
      db.exec('ROLLBACK')
      send(res, 404, { error: 'Ocorrência não encontrada.' })
      return true
    }
    if (incident.status === 'resolved' || (action === 'acknowledge' && incident.status === 'acknowledged')) {
      db.exec('COMMIT')
      send(res, 200, { ok: true, status: incident.status, idempotent: true })
      return true
    }
    if (action === 'resolve' && incident.kind === 'publication_uncertain' &&
      incident.jobStatus === 'awaiting_confirmation') {
      db.exec('ROLLBACK')
      send(res, 409, {
        error: 'Confirme o resultado em Publicações antes de encerrar uma ocorrência de publicação incerta.',
      })
      return true
    }
    const next = action === 'acknowledge' ? 'acknowledged' : 'resolved'
    db.prepare(
      `UPDATE operational_incidents SET status=?,
      acknowledged_by=CASE WHEN ?='acknowledged' THEN ? ELSE acknowledged_by END,
      acknowledged_at=CASE WHEN ?='acknowledged' THEN CURRENT_TIMESTAMP ELSE acknowledged_at END,
      resolved_by=CASE WHEN ?='resolved' THEN ? ELSE resolved_by END,
      resolved_at=CASE WHEN ?='resolved' THEN CURRENT_TIMESTAMP ELSE resolved_at END
      WHERE id=? AND organization_id=?`,
    ).run(next, next, auth.userId, next, next, auth.userId, next, incidentId, organizationId)
    db.prepare(
      `INSERT INTO operational_incident_actions(organization_id,incident_id,action,actor_user_id,note)
       VALUES (?,?,?,?,?)`,
    ).run(organizationId, incidentId, action === 'acknowledge' ? 'acknowledged' : 'resolved', auth.userId, note)
    db.exec('COMMIT')
    send(res, 200, { ok: true, status: next })
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
