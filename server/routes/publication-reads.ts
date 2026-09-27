import {
  publicationMayExist,
  ambiguousPublicationReport,
} from '../services/publication-evidence.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

type AuthContext = { userId: number; organizationId: number }
type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  userById: (id: number) => unknown
  recordJobEvent: (
    organizationId: number,
    jobId: number,
    eventType: string,
    createdBy?: number | null,
    details?: Record<string, unknown>,
  ) => void
}

export function isPublicationReadRoute(req: IncomingMessage, url: URL) {
  if (
    req.method === 'GET' &&
    [
      '/api/publications/paged',
      '/api/publications',
      '/api/reports/issues',
      '/api/reports/performance',
    ].includes(url.pathname)
  )
    return true
  if (req.method === 'GET' && /^\/api\/publications\/\d+$/.test(url.pathname)) return true
  if (req.method === 'GET' && /^\/api\/publications\/\d+\/timeline$/.test(url.pathname)) return true
  return req.method === 'POST' && /^\/api\/publications\/\d+\/recover$/.test(url.pathname)
}

export async function handlePublicationReadRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext,
  { db, send, userById, recordJobEvent }: Dependencies,
): Promise<void> {
  const publicationDetail = url.pathname.match(/^\/api\/publications\/(\d+)$/)
  if (req.method === 'GET' && publicationDetail) {
    const row = db
      .prepare(
        `SELECT id,status,fill_report fillReport FROM publication_jobs
        WHERE id=? AND organization_id=?`,
      )
      .get(Number(publicationDetail[1]), auth.organizationId) as
      { id: number; status: string; fillReport: string } | undefined
    if (!row) return send(res, 404, { error: 'Publicação não encontrada.' })
    let fillReport: Record<string, unknown> | null = null
    try {
      fillReport = row.fillReport ? JSON.parse(row.fillReport) : null
    } catch {
      /* relatório antigo inválido */
    }
    return send(res, 200, { job: { id: row.id, status: row.status, fillReport } })
  }
  if (req.method === 'GET' && url.pathname === '/api/reports/performance') {
    const period = String(url.searchParams.get('period') || '30')
    const days = period === 'all' ? null : Number(period)
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650))
      return send(res, 400, { error: 'Período de relatório inválido.' })
    const seller = String(url.searchParams.get('seller') || 'Todos')
      .trim()
      .slice(0, 120)
    const clauses = ['j.organization_id=?'],
      params: Array<string | number> = [auth.organizationId]
    if (days !== null) {
      clauses.push("julianday(j.created_at)>=julianday('now',?)")
      params.push(`-${days} days`)
    }
    if (seller && seller !== 'Todos') {
      clauses.push("COALESCE(u.name,'Não atribuído')=?")
      params.push(seller)
    }
    const where = `WHERE ${clauses.join(' AND ')}`
    const summary = db
      .prepare(
        `SELECT COUNT(*) total,
        SUM(CASE WHEN j.status IN ('completed','removed') THEN 1 ELSE 0 END) completed,
        SUM(CASE WHEN j.status='error' THEN 1 ELSE 0 END) errors,
        SUM(CASE WHEN j.status IN ('pending','filling','awaiting_confirmation') THEN 1 ELSE 0 END) active,
        SUM(CASE WHEN json_valid(j.fill_report) AND json_extract(j.fill_report,'$.published')=1 THEN 1 ELSE 0 END) automatic,
        SUM(CASE WHEN json_valid(j.fill_report) AND json_type(j.fill_report,'$.selectedGroups')='array'
          THEN json_array_length(j.fill_report,'$.selectedGroups') ELSE 0 END) groupsSelected
        FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN users u ON u.id=v.assigned_user_id ${where}`,
      )
      .get(...params) as Record<string, number>
    const sellerPerformance = db
      .prepare(
        `SELECT COALESCE(u.name,'Não atribuído') name,COUNT(*) total,
        SUM(CASE WHEN j.status IN ('completed','removed') THEN 1 ELSE 0 END) done
        FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN users u ON u.id=v.assigned_user_id
        ${where} GROUP BY name ORDER BY done DESC,total DESC,name`,
      )
      .all(...params) as Array<{ name: string; total: number; done: number }>
    const profilePerformance = db
      .prepare(
        `SELECT COALESCE(a.label,'Perfil não definido') name,COUNT(*) total,
        SUM(CASE WHEN j.status IN ('completed','removed') THEN 1 ELSE 0 END) done,
        SUM(CASE WHEN j.status='error' THEN 1 ELSE 0 END) fail
        FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN users u ON u.id=v.assigned_user_id
        LEFT JOIN social_accounts a ON a.id=j.social_account_id ${where} GROUP BY name ORDER BY total DESC,name`,
      )
      .all(...params) as Array<{ name: string; total: number; done: number; fail: number }>
    const sellerOptions = db
      .prepare(
        `SELECT DISTINCT COALESCE(u.name,'Não atribuído') name
        FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN users u ON u.id=v.assigned_user_id
        WHERE j.organization_id=? ORDER BY name`,
      )
      .all(auth.organizationId) as Array<{ name: string }>
    const recentRows = db
      .prepare(
        `SELECT j.id,j.status,j.result_url resultUrl,j.error_code errorCode,j.fill_report fillReport,
        j.extension_version extensionVersion,j.extension_visible extensionVisible,j.queue_priority queuePriority,j.paused,
        j.scheduled_at scheduledAt,j.started_at startedAt,j.filled_at filledAt,j.removed_at removedAt,
        j.created_at createdAt,j.updated_at updatedAt,j.retry_count retryCount,j.max_retries maxRetries,
        v.id vehicleId,v.year,v.make,v.model,v.price,j.social_account_id accountId,
        COALESCE(a.label,'Perfil não definido') accountLabel,COALESCE(u.name,'Não atribuído') seller
        FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN social_accounts a ON a.id=j.social_account_id
        LEFT JOIN users u ON u.id=v.assigned_user_id ${where}
        ORDER BY datetime(j.created_at) DESC,j.id DESC LIMIT 8`,
      )
      .all(...params) as Array<Record<string, unknown>>
    const recent = recentRows.map((row) => {
      try {
        return { ...row, fillReport: row.fillReport ? JSON.parse(String(row.fillReport)) : null }
      } catch {
        return { ...row, fillReport: null }
      }
    })
    return send(res, 200, {
      summary,
      sellerPerformance: sellerPerformance.map((item) => ({
        ...item,
        rate: item.total ? Math.round((item.done / item.total) * 100) : 0,
      })),
      profilePerformance: profilePerformance.map((item) => ({
        ...item,
        rate: item.total ? Math.round((item.done / item.total) * 100) : 0,
      })),
      sellerOptions: sellerOptions.map((item) => item.name),
      recent,
    })
  }
  if (req.method === 'GET' && url.pathname === '/api/publications/paged') {
    const pageRaw = Number(url.searchParams.get('page') || 1),
      pageSizeRaw = Number(url.searchParams.get('limit') || 25)
    if (
      !Number.isInteger(pageRaw) ||
      pageRaw < 1 ||
      !Number.isInteger(pageSizeRaw) ||
      pageSizeRaw < 1
    )
      return send(res, 400, { error: 'Parâmetros de paginação inválidos.' })
    const pageSize = Math.min(100, pageSizeRaw),
      query = String(url.searchParams.get('query') || '')
        .trim()
        .slice(0, 100)
    const status = String(url.searchParams.get('status') || 'all'),
      account = String(url.searchParams.get('account') || 'all'),
      situation = String(url.searchParams.get('situation') || 'all')
    const jobStatuses = [
      'pending',
      'filling',
      'awaiting_confirmation',
      'completed',
      'error',
      'canceled',
      'removed',
    ]
    const situations = ['all', 'available', 'scheduled', 'paused', 'stalled', 'hidden']
    if (
      (status !== 'all' && !jobStatuses.includes(status)) ||
      (account !== 'all' && (!Number.isInteger(Number(account)) || Number(account) <= 0)) ||
      !situations.includes(situation)
    )
      return send(res, 400, { error: 'Filtros de publicação inválidos.' })
    const conditions = ['j.organization_id=?'],
      params: Array<string | number> = [auth.organizationId]
    if (query) {
      conditions.push(
        "lower(CAST(j.id AS TEXT)||' '||v.make||' '||v.model||' '||v.year||' '||COALESCE(u.name,'')||' '||COALESCE(a.label,'')) LIKE '%'||lower(?)||'%'",
      )
      params.push(query)
    }
    if (status !== 'all') {
      conditions.push('j.status=?')
      params.push(status)
    }
    if (account !== 'all') {
      conditions.push('j.social_account_id=?')
      params.push(Number(account))
    }
    const active = "j.status IN ('pending','filling','error','awaiting_confirmation')"
    if (situation === 'available')
      conditions.push(
        `${active} AND j.extension_visible=1 AND j.paused=0 AND (j.scheduled_at IS NULL OR datetime(j.scheduled_at)<=CURRENT_TIMESTAMP)`,
      )
    if (situation === 'scheduled')
      conditions.push(
        `${active} AND j.scheduled_at IS NOT NULL AND datetime(j.scheduled_at)>CURRENT_TIMESTAMP`,
      )
    if (situation === 'paused') conditions.push('j.paused=1')
    if (situation === 'hidden') conditions.push(`${active} AND j.extension_visible=0`)
    if (situation === 'stalled')
      conditions.push(
        "j.status='filling' AND (j.lease_expires_at IS NULL OR datetime(j.lease_expires_at)<=CURRENT_TIMESTAMP) AND j.started_at IS NOT NULL AND (strftime('%s','now')-strftime('%s',j.started_at))>=COALESCE(s.stuck_timeout_minutes,15)*60",
      )
    const joins = `FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN social_accounts a ON a.id=j.social_account_id LEFT JOIN users u ON u.id=v.assigned_user_id LEFT JOIN organization_settings s ON s.organization_id=j.organization_id`
    const where = `WHERE ${conditions.join(' AND ')}`
    const total = Number(
      (db.prepare(`SELECT COUNT(*) total ${joins} ${where}`).get(...params) as { total: number })
        .total,
    )
    const totalPages = Math.max(1, Math.ceil(total / pageSize)),
      currentPage = Math.min(pageRaw, totalPages),
      offset = (currentPage - 1) * pageSize
    const rows = db
      .prepare(
        `SELECT j.id,j.status,j.result_url resultUrl,j.error_code errorCode,j.fill_report fillReport,j.extension_version extensionVersion,j.extension_visible extensionVisible,j.queue_priority queuePriority,j.paused,j.scheduled_at scheduledAt,j.started_at startedAt,j.filled_at filledAt,j.removed_at removedAt,j.created_at createdAt,j.updated_at updatedAt,j.retry_count retryCount,j.max_retries maxRetries,v.id vehicleId,v.year,v.make,v.model,v.price,j.social_account_id accountId,COALESCE(a.label,'Perfil não definido') accountLabel,COALESCE(u.name,'Não atribuído') seller ${joins} ${where} ORDER BY CASE WHEN ${active} THEN 0 ELSE 1 END,j.paused,j.queue_priority,j.created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset) as Array<Record<string, unknown>>
    const jobs = rows.map((item) => {
      try {
        return { ...item, fillReport: item.fillReport ? JSON.parse(String(item.fillReport)) : null }
      } catch {
        return { ...item, fillReport: null }
      }
    })
    return send(res, 200, {
      jobs,
      pagination: { totalItems: total, totalPages, currentPage, pageSize },
    })
  }
  if (req.method === 'GET' && url.pathname === '/api/publications') {
    const rows = db
      .prepare(
        `SELECT j.id,j.status,j.result_url resultUrl,j.error_code errorCode,j.fill_report fillReport,
        j.extension_version extensionVersion,j.extension_visible extensionVisible,j.queue_priority queuePriority,j.paused,j.scheduled_at scheduledAt,j.started_at startedAt,j.filled_at filledAt,j.removed_at removedAt,j.created_at createdAt,j.updated_at updatedAt,j.retry_count retryCount,j.max_retries maxRetries,
        v.id vehicleId,v.year,v.make,v.model,v.price,j.social_account_id accountId,COALESCE(a.label,'Perfil não definido') accountLabel,
        (SELECT previous.label FROM publication_job_events event LEFT JOIN social_accounts previous ON previous.id=event.from_account_id
          WHERE event.publication_job_id=j.id AND event.event_type='reassigned' ORDER BY event.created_at DESC,event.id DESC LIMIT 1) previousAccountLabel,
        (SELECT event.created_at FROM publication_job_events event WHERE event.publication_job_id=j.id AND event.event_type='reassigned' ORDER BY event.created_at DESC,event.id DESC LIMIT 1) reassignedAt,
        COALESCE(u.name,'Não atribuído') seller FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id
        LEFT JOIN social_accounts a ON a.id=j.social_account_id LEFT JOIN users u ON u.id=v.assigned_user_id
        WHERE j.organization_id=? ORDER BY CASE WHEN j.status IN ('pending','filling','error','awaiting_confirmation') THEN 0 ELSE 1 END,j.paused,j.queue_priority,j.created_at DESC`,
      )
      .all(auth.organizationId)
    const jobs = (rows as Array<Record<string, unknown>>).map((item) => {
      try {
        return { ...item, fillReport: item.fillReport ? JSON.parse(String(item.fillReport)) : null }
      } catch {
        return { ...item, fillReport: null }
      }
    })
    return send(res, 200, { jobs })
  }
  if (req.method === 'GET' && url.pathname === '/api/reports/issues') {
    type IssueEventRow = {
      eventId: number
      eventType: string
      details: string
      occurredAt: string
      jobId: number
      jobStatus: string
      extensionVersion?: string
      year: number
      make: string
      model: string
      accountLabel: string
      seller: string
      latestIssueEventId?: number
    }
    const limit = Math.max(
      1,
      Math.min(100, Math.floor(Number(url.searchParams.get('limit')) || 50)),
    )
    const beforeRaw = url.searchParams.get('before'),
      before = beforeRaw === null ? null : Number(beforeRaw)
    if (before !== null && (!Number.isInteger(before) || before <= 0))
      return send(res, 400, { error: 'Cursor de paginação inválido.' })
    const baseIssueSql = `SELECT event.id eventId,event.event_type eventType,event.details,event.created_at occurredAt,
        j.id jobId,j.status jobStatus,j.extension_version extensionVersion,v.year,v.make,v.model,
        COALESCE(a.label,'Perfil não definido') accountLabel,COALESCE(u.name,'Não atribuído') seller,
        (SELECT MAX(latest.id) FROM publication_job_events latest WHERE latest.publication_job_id=j.id
          AND latest.event_type IN ('fill_error','filled_waiting_confirmation','stalled_recovered','duplicate_blocked')) latestIssueEventId
        FROM publication_job_events event JOIN publication_jobs j ON j.id=event.publication_job_id
        JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN social_accounts a ON a.id=j.social_account_id
        LEFT JOIN users u ON u.id=v.assigned_user_id WHERE event.organization_id=?
        AND event.event_type IN ('fill_error','filled_waiting_confirmation','stalled_recovered','duplicate_blocked')`
    const rows = (
      before === null
        ? db
            .prepare(`${baseIssueSql} ORDER BY event.id DESC LIMIT ?`)
            .all(auth.organizationId, limit + 1)
        : db
            .prepare(`${baseIssueSql} AND event.id<? ORDER BY event.id DESC LIMIT ?`)
            .all(auth.organizationId, before, limit + 1)
    ) as IssueEventRow[]
    const hasMore = rows.length > limit,
      pageRows = rows.slice(0, limit)
    const issues: Array<Record<string, unknown>> = []
    for (const row of pageRows) {
      let details: Record<string, unknown> = {}
      try {
        details = JSON.parse(String(row.details || '{}'))
      } catch {
        /* evento antigo sem JSON válido */
      }
      const base = {
        eventId: row.eventId,
        jobId: row.jobId,
        jobStatus: row.jobStatus,
        extensionVersion: String(details.extensionVersion || row.extensionVersion || ''),
        year: row.year,
        make: row.make,
        model: row.model,
        accountLabel: row.accountLabel,
        seller: row.seller,
        occurredAt: row.occurredAt,
      }
      const active =
        Number(row.eventId) === Number(row.latestIssueEventId) &&
        ((row.eventType === 'fill_error' && row.jobStatus === 'error') ||
          (row.eventType === 'filled_waiting_confirmation' &&
            row.jobStatus === 'awaiting_confirmation') ||
          (row.eventType === 'duplicate_blocked' &&
            ['pending', 'awaiting_confirmation'].includes(row.jobStatus)))
      const add = (severity: 'error' | 'warning', category: string, message: string) =>
        issues.push({ ...base, severity, category, message: String(message).slice(0, 300), active })
      if (row.eventType === 'fill_error')
        add(
          'error',
          'execution',
          String(details.error || 'Falha durante o preenchimento no Facebook.'),
        )
      if (row.eventType === 'filled_waiting_confirmation') {
        for (const field of Array.isArray(details.missing) ? details.missing : [])
          add('warning', 'fields', `Campo não confirmado: ${field}`)
        for (const group of Array.isArray(details.missingGroups) ? details.missingGroups : [])
          add('warning', 'groups', `Grupo não encontrado: ${group}`)
        for (const issue of Array.isArray(details.flowIssues) ? details.flowIssues : [])
          add('warning', 'flow', issue)
      }
      if (row.eventType === 'stalled_recovered')
        add(
          'warning',
          'recovery',
          `Execução travada recuperada${Number(details.elapsedMinutes) > 0 ? ` após ${details.elapsedMinutes} min` : ''}.`,
        )
      if (row.eventType === 'duplicate_blocked')
        add(
          'warning',
          'duplicate',
          String(
            details.message || 'Possível anúncio duplicado bloqueado antes do envio ao Facebook.',
          ),
        )
    }
    const page = { limit, hasMore, nextCursor: hasMore ? pageRows.at(-1)?.eventId || null : null }
    return send(res, 200, {
      issues,
      generatedAt: new Date().toISOString(),
      definitions: {
        errors: 'Falhas que interromperam uma tentativa de preenchimento.',
        warnings: 'Campos, grupos, etapas ou recuperações que exigiram atenção.',
      },
      page,
    })
  }
  const publicationTimeline = url.pathname.match(/^\/api\/publications\/(\d+)\/timeline$/)
  if (req.method === 'GET' && publicationTimeline) {
    const job = db
      .prepare(
        `SELECT j.id,j.created_at createdAt,v.year,v.make,v.model,COALESCE(a.label,'Perfil não definido') accountLabel
        FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN social_accounts a ON a.id=j.social_account_id
        WHERE j.id=? AND j.organization_id=?`,
      )
      .get(Number(publicationTimeline[1]), auth.organizationId) as
      | {
          id: number
          createdAt: string
          year: number
          make: string
          model: string
          accountLabel: string
        }
      | undefined
    if (!job) return send(res, 404, { error: 'Publicação não encontrada.' })
    const rows = db
      .prepare(
        `SELECT event.id,event.event_type eventType,event.details,event.created_at createdAt,
        COALESCE(user.name,'Extensão AutoFlow') actor,previous.label fromAccount,next.label toAccount
        FROM publication_job_events event LEFT JOIN users user ON user.id=event.created_by
        LEFT JOIN social_accounts previous ON previous.id=event.from_account_id LEFT JOIN social_accounts next ON next.id=event.to_account_id
        WHERE event.organization_id=? AND event.publication_job_id=? ORDER BY datetime(event.created_at) DESC,event.id DESC`,
      )
      .all(auth.organizationId, job.id) as Array<{
      id: number
      eventType: string
      details: string
      createdAt: string
      actor: string
      fromAccount: string | null
      toAccount: string | null
    }>
    const events = rows.map((row) => {
      let details: Record<string, unknown> = {}
      try {
        details = JSON.parse(String(row.details || '{}'))
      } catch {
        /* evento antigo sem JSON válido */
      }
      return { ...row, details }
    })
    if (!events.some((event) => event.eventType === 'created'))
      events.push({
        id: 0,
        eventType: 'created',
        details: { accountLabel: job.accountLabel },
        createdAt: job.createdAt,
        actor: 'Sistema',
        fromAccount: null,
        toAccount: null,
      })
    events.sort(
      (a, b) =>
        Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)) ||
        Number(b.id) - Number(a.id),
    )
    return send(res, 200, { job, events })
  }
  const recoverPublication = url.pathname.match(/^\/api\/publications\/(\d+)\/recover$/)
  if (req.method === 'POST' && recoverPublication) {
    const currentUser = userById(auth.userId) as { role?: string } | undefined
    if (currentUser?.role !== 'admin')
      return send(res, 403, {
        error: 'Somente administradores podem recuperar trabalhos em preenchimento.',
      })
    const job = db
      .prepare(
        `SELECT id,status,started_at startedAt,lease_expires_at leaseExpiresAt,publish_attempt_at publishAttemptAt,fill_report fillReport FROM publication_jobs WHERE id=? AND organization_id=?`,
      )
      .get(Number(recoverPublication[1]), auth.organizationId) as
      | {
          id: number
          status: string
          startedAt?: string
          leaseExpiresAt?: string
          publishAttemptAt?: string
          fillReport?: string
        }
      | undefined
    if (!job) return send(res, 404, { error: 'Trabalho não encontrado.' })
    if (job.status !== 'filling')
      return send(res, 409, { error: 'Somente trabalhos em preenchimento podem ser recuperados.' })
    const elapsedMinutes = job.startedAt
      ? Math.max(
          0,
          Math.floor((Date.now() - Date.parse(job.startedAt.replace(' ', 'T') + 'Z')) / 60000),
        )
      : 0
    const timeout =
      (
        db
          .prepare(
            'SELECT stuck_timeout_minutes value FROM organization_settings WHERE organization_id=?',
          )
          .get(auth.organizationId) as { value?: number } | undefined
      )?.value || 15
    if (elapsedMinutes < timeout)
      return send(res, 409, {
        error: `Este trabalho ainda está dentro do tempo normal de preenchimento (${timeout} min).`,
      })
    const leaseExpiresAt = job.leaseExpiresAt
      ? Date.parse(job.leaseExpiresAt.replace(' ', 'T') + 'Z')
      : 0
    if (leaseExpiresAt > Date.now())
      return send(res, 409, {
        error: 'A extensao ainda esta trabalhando neste item. Aguarde o fim do bloqueio exclusivo.',
      })
    if (publicationMayExist(job)) {
      db.exec('BEGIN')
      try {
        db.prepare(
          `UPDATE publication_jobs SET status='awaiting_confirmation',paused=1,extension_visible=0,
            fill_report=?,error_code=NULL,last_lease_token=COALESCE(lease_token,last_lease_token),lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
            WHERE id=? AND organization_id=?`,
        ).run(
          JSON.stringify(ambiguousPublicationReport(job.fillReport)),
          job.id,
          auth.organizationId,
        )
        recordJobEvent(auth.organizationId, job.id, 'stalled_publish_ambiguous', auth.userId, {
          elapsedMinutes,
        })
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return send(res, 200, { ok: true, status: 'awaiting_confirmation', ambiguous: true })
    }
    db.exec('BEGIN')
    try {
      db.prepare(
        "UPDATE publication_jobs SET status='pending',paused=0,extension_visible=1,error_code=NULL,fill_report='',last_lease_token=NULL,publish_attempt_at=NULL,started_at=NULL,filled_at=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
      ).run(job.id, auth.organizationId)
      recordJobEvent(auth.organizationId, job.id, 'stalled_recovered', auth.userId, {
        fromStatus: 'filling',
        toStatus: 'pending',
        elapsedMinutes,
        leaseExpired: true,
      })
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return send(res, 200, {
      ok: true,
      status: 'pending',
      recovery: {
        jobId: job.id,
        fromStatus: 'filling',
        toStatus: 'pending',
        elapsedMinutes,
        leaseExpired: true,
      },
    })
  }
  return
}
