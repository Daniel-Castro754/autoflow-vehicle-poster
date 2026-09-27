import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync, StatementSync } from 'node:sqlite'

type AuthContext = { userId: number; organizationId: number }
type AutomationAccount = {
  id: number
  label: string
  browserProfile?: string
  status: string
  lastSeenAt?: string
  owner: string
}
type LatestAutomationJob = {
  accountId: number
  id: number
  status: string
  paused: number
  scheduledAt?: string
  attemptCount?: number
  fillReport?: string
  extensionVersion?: string
  startedAt?: string
  updatedAt?: string
  leaseExpiresAt?: string
  year: number
  make: string
  model: string
}
type AutomationStats = { accountId: number; today: number; successes: number; failures: number }

type AutomationStatements = {
  accountsAdmin: StatementSync
  accountsSeller: StatementSync
  settings: StatementSync
  latest: StatementSync
  stats: StatementSync
}

export function createAutomationStatements(db: DatabaseSync): AutomationStatements {
  return {
    accountsAdmin:
      db.prepare(`SELECT a.id,a.label,a.browser_profile browserProfile,a.status,a.last_seen_at lastSeenAt,u.name owner
      FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.organization_id=? ORDER BY u.name,a.label`),
    accountsSeller:
      db.prepare(`SELECT a.id,a.label,a.browser_profile browserProfile,a.status,a.last_seen_at lastSeenAt,u.name owner
      FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.organization_id=? AND a.user_id=? ORDER BY a.label`),
    settings: db.prepare(
      'SELECT daily_limit dailyLimit,stuck_timeout_minutes stuckTimeoutMinutes FROM organization_settings WHERE organization_id=?',
    ),
    latest: db.prepare(`WITH ranked AS (
      SELECT j.social_account_id accountId,j.id,j.status,j.paused,j.scheduled_at scheduledAt,j.attempt_count attemptCount,j.extension_version extensionVersion,
        j.started_at startedAt,j.updated_at updatedAt,j.lease_expires_at leaseExpiresAt,v.year,v.make,v.model,
        ROW_NUMBER() OVER (PARTITION BY j.social_account_id ORDER BY
          CASE WHEN j.status IN ('filling','pending','awaiting_confirmation','error') AND j.paused=0 AND (j.scheduled_at IS NULL OR datetime(j.scheduled_at)<=CURRENT_TIMESTAMP) THEN 0
            WHEN j.status IN ('filling','pending','awaiting_confirmation','error') AND j.paused=0 THEN 1
            WHEN j.status IN ('filling','pending','awaiting_confirmation','error') THEN 2 ELSE 3 END,
          j.queue_priority,j.updated_at DESC) rank
      FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id WHERE j.organization_id=? AND j.social_account_id IS NOT NULL
    ) SELECT accountId,id,status,paused,scheduledAt,attemptCount,
      (SELECT CASE WHEN json_valid(j.fill_report) THEN json_object(
        'advanced',json_extract(j.fill_report,'$.advanced'),'publishAttempted',json_extract(j.fill_report,'$.publishAttempted'),
        'missing',json_extract(j.fill_report,'$.missing'),'missingGroups',json_extract(j.fill_report,'$.missingGroups'),
        'flowIssues',json_extract(j.fill_report,'$.flowIssues')) ELSE NULL END
        FROM publication_jobs j WHERE j.id=ranked.id) fillReport,
      extensionVersion,startedAt,updatedAt,leaseExpiresAt,year,make,model FROM ranked WHERE rank=1`),
    stats: db.prepare(`SELECT social_account_id accountId,
      SUM(CASE WHEN autoflow_day(created_at)=autoflow_day(CURRENT_TIMESTAMP) AND status!='canceled' THEN 1 ELSE 0 END) today,
      SUM(CASE WHEN status IN ('completed','removed') THEN 1 ELSE 0 END) successes,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) failures
      FROM publication_jobs WHERE organization_id=? AND social_account_id IS NOT NULL GROUP BY social_account_id`),
  }
}

export function handleDashboardRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext,
  db: DatabaseSync,
  send: (res: ServerResponse, status: number, data: unknown) => void,
  automationStatements: AutomationStatements,
  isAdmin: (auth: AuthContext) => boolean,
): boolean {
  if (req.method === 'GET' && url.pathname === '/api/team') {
    const users = db
      .prepare('SELECT id,name,email,role,active FROM users WHERE organization_id=? ORDER BY name')
      .all(auth.organizationId)
    const accounts = db
      .prepare(
        `SELECT a.id,a.user_id userId,a.label,a.platform,a.status,a.browser_profile browserProfile,a.last_seen_at lastSeenAt,
        a.automation_paused automationPaused,a.automation_pause_reason automationPauseReason,a.automation_paused_at automationPausedAt,u.name owner
      FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.organization_id=? ORDER BY u.name,a.label`,
      )
      .all(auth.organizationId)
    send(res, 200, { users, accounts, canManageQueue: isAdmin(auth) })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/stats/global') {
    const vehicles = db
      .prepare(
        `SELECT COUNT(*) total,
      SUM(CASE WHEN status='Publicado' THEN 1 ELSE 0 END) published,
      SUM(CASE WHEN status='Pronto' THEN 1 ELSE 0 END) ready,
      SUM(CASE WHEN status='Atenção' THEN 1 ELSE 0 END) attention,
      SUM(CASE WHEN status='Vendido' AND EXISTS(SELECT 1 FROM publication_jobs j WHERE j.vehicle_id=vehicles.id AND j.status='completed') THEN 1 ELSE 0 END) soldPendingRemoval,
      SUM(CASE WHEN status='Vendido' AND sold_at IS NOT NULL AND julianday('now')-julianday(sold_at)>1
        AND EXISTS(SELECT 1 FROM publication_jobs j WHERE j.vehicle_id=vehicles.id AND j.status='completed') THEN 1 ELSE 0 END) soldRemovalOverdue
      FROM vehicles WHERE organization_id=?`,
      )
      .get(auth.organizationId)
    const publications = db
      .prepare(
        `SELECT COUNT(*) total,
      SUM(CASE WHEN status IN ('pending','filling','awaiting_confirmation') THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN status IN ('completed','removed') THEN 1 ELSE 0 END) completed,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors,
      SUM(CASE WHEN status IN ('pending','filling','error','awaiting_confirmation') AND extension_visible=1 AND paused=0 AND (scheduled_at IS NULL OR datetime(scheduled_at)<=CURRENT_TIMESTAMP) THEN 1 ELSE 0 END) extensionAvailable,
      SUM(CASE WHEN status IN ('pending','filling','error','awaiting_confirmation') AND scheduled_at IS NOT NULL AND datetime(scheduled_at)>CURRENT_TIMESTAMP THEN 1 ELSE 0 END) scheduled
      FROM publication_jobs WHERE organization_id=?`,
      )
      .get(auth.organizationId)
    send(res, 200, { vehicles, publications })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/overview') {
    const vehicleStats = db
      .prepare(
        `SELECT COUNT(*) total,
      SUM(CASE WHEN status='Publicado' THEN 1 ELSE 0 END) published,
      SUM(CASE WHEN status='Pronto' THEN 1 ELSE 0 END) ready,
      SUM(CASE WHEN status='Atenção' THEN 1 ELSE 0 END) attention,
      COALESCE(SUM(price),0) inventoryValue FROM vehicles WHERE organization_id=?`,
      )
      .get(auth.organizationId)
    const jobStats = db
      .prepare(
        `SELECT COUNT(*) jobs,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors FROM publication_jobs WHERE organization_id=?`,
      )
      .get(auth.organizationId)
    send(res, 200, { vehicleStats, jobStats })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/automation/overview') {
    return automationOverview(res, auth, isAdmin(auth), send, automationStatements)
  }
  return false
}

function automationOverview(
  res: ServerResponse,
  auth: AuthContext,
  admin: boolean,
  send: (res: ServerResponse, status: number, data: unknown) => void,
  statements: AutomationStatements,
) {
  const accounts = (
    admin
      ? statements.accountsAdmin.all(auth.organizationId)
      : statements.accountsSeller.all(auth.organizationId, auth.userId)
  ) as AutomationAccount[]
  const settings = statements.settings.get(auth.organizationId) as
    { dailyLimit?: number; stuckTimeoutMinutes?: number } | undefined
  const latestRows = statements.latest.all(auth.organizationId) as LatestAutomationJob[]
  const latestByAccount = new Map(latestRows.map((item) => [item.accountId, item]))
  const statsRows = statements.stats.all(auth.organizationId) as AutomationStats[]
  const statsByAccount = new Map(statsRows.map((item) => [item.accountId, item]))
  const profiles = accounts.map((account) => {
    const latest = latestByAccount.get(account.id)
    const stats = statsByAccount.get(account.id)
    const today = Number(stats?.today || 0),
      successes = Number(stats?.successes || 0),
      failures = Number(stats?.failures || 0)
    let report: {
      advanced?: boolean
      publishAttempted?: boolean
      missing?: string[]
      missingGroups?: string[]
      flowIssues?: string[]
    } | null = null
    try {
      report = latest?.fillReport ? JSON.parse(latest.fillReport) : null
    } catch {
      // Ignore malformed reports written by older extension versions.
    }
    const scheduled = latest?.scheduledAt && Date.parse(latest.scheduledAt) > Date.now()
    let stage = !latest
      ? 'Sem atividade'
      : latest.paused
        ? 'Pausado pelo painel'
        : scheduled
          ? 'Aguardando horário agendado'
          : latest.status === 'pending'
            ? 'Na fila'
            : latest.status === 'filling'
              ? 'Preenchendo dados'
              : latest.status === 'error'
                ? 'Erro — requer revisão'
                : latest.status === 'awaiting_confirmation'
                  ? report?.advanced
                    ? 'Etapa final / revisão'
                    : 'Dados preenchidos'
                  : latest.status === 'completed'
                    ? 'Publicado'
                    : latest.status === 'removed'
                      ? 'Anúncio removido'
                      : 'Encerrado'
    const lastSeenTime = account.lastSeenAt
      ? Date.parse(String(account.lastSeenAt).replace(' ', 'T') + 'Z')
      : 0
    const online = account.status === 'connected' && lastSeenTime > Date.now() - 5 * 60 * 1000
    const startedTime = latest?.startedAt
      ? Date.parse(String(latest.startedAt).replace(' ', 'T') + 'Z')
      : 0
    const durationSeconds = startedTime
      ? Math.max(0, Math.round((Date.now() - startedTime) / 1000))
      : 0
    const leaseTime = latest?.leaseExpiresAt
      ? Date.parse(String(latest.leaseExpiresAt).replace(' ', 'T') + 'Z')
      : 0
    const leaseActive = latest?.status === 'filling' && leaseTime > Date.now()
    const stuckTimeoutMinutes = Number(settings?.stuckTimeoutMinutes || 15)
    const stalled =
      latest?.status === 'filling' && !leaseActive && durationSeconds >= stuckTimeoutMinutes * 60
    if (stalled)
      stage = `Preenchimento travado há ${Math.max(1, Math.floor(durationSeconds / 60))} min`
    return {
      ...account,
      online,
      today,
      dailyLimit: Number(settings?.dailyLimit || 10),
      successes,
      failures,
      stage,
      currentJob: latest
        ? {
            id: latest.id,
            status: latest.status,
            paused: Boolean(latest.paused),
            scheduledAt: latest.scheduledAt,
            attemptCount: latest.attemptCount || 0,
            extensionVersion: latest.extensionVersion || '',
            startedAt: latest.startedAt,
            updatedAt: latest.updatedAt,
            leaseActive,
            leaseExpiresAt: latest.leaseExpiresAt,
            publishAttempted: Boolean(report?.publishAttempted),
            year: latest.year,
            make: latest.make,
            model: latest.model,
            durationSeconds,
            stalled,
            stuckTimeoutMinutes,
            issues: [
              ...(report?.missing || []),
              ...(report?.missingGroups || []),
              ...(report?.flowIssues || []),
            ],
          }
        : null,
    }
  })
  send(res, 200, { profiles, serverNow: new Date().toISOString(), onlineWindowSeconds: 300 })
  return true
}
