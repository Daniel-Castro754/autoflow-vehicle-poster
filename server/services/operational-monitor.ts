import type { DatabaseSync } from 'node:sqlite'
import { consumerState, latestConsumerDecision } from './execution-diagnostics.ts'
import { profileCapacity, parseSqliteTimestamp } from './profile-capacity.ts'
import { publicationReviewKind } from './publication-evidence.ts'

const eventGroups = {
  scheduling: ['autopilot_scheduled','created','scheduled','smart_scheduled'],
  recovery: ['stalled_recovered','auto_retry_scheduled','retry_requested'],
  transfer: ['reassigned'],
  attention: ['fill_error','stalled_exhausted','stalled_publish_ambiguous','publish_result_unknown','duplicate_blocked','selector_circuit_breaker_opened','job_nearly_stuck','filled_waiting_confirmation'],
  execution: ['filling_started','auto_published','late_publish_confirmed','confirmed_published','canceled','marked_removed'],
} as const
type Category = keyof typeof eventGroups
export function monitorFilters(params: URLSearchParams) {
  const integer = (key: string, fallback: number) => {
    const raw = params.get(key)
    if (raw === null) return fallback
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw)<1) throw new Error('Filtro inválido: '+key)
    return Number(raw)
  }
  const category = params.get('category') || 'all'
  if (category !== 'all' && !Object.hasOwn(eventGroups,category)) throw new Error('Categoria inválida.')
  const hours = integer('hours',24)
  if (![24,168,720].includes(hours)) throw new Error('Período inválido.')
  return { category: category as Category|'all', hours, accountId: integer('accountId',0),
    vehicleId: integer('vehicleId',0), beforeId: integer('beforeId',0), limit: Math.min(integer('limit',30),100) }
}

export function operationalMonitor(db: DatabaseSync, org: number, filters: ReturnType<typeof monitorFilters>) {
  const now = Date.now()
  const accounts = db.prepare(`SELECT id,label,status,last_seen_at lastSeenAt,automation_paused paused
    FROM social_accounts WHERE organization_id=? ORDER BY label,id`).all(org) as Array<{id:number;label:string;status:string;lastSeenAt:string|null;paused:number}>
  const profiles = accounts.map(a=>{
    const seen = parseSqliteTimestamp(a.lastSeenAt)
    const online = a.status==='connected' && seen!==null && now-seen<=300000
    const consumer = consumerState(db,org,a.id,now)
    const capacity = profileCapacity(db,org,a.id,now)
    const queue = db.prepare(`SELECT COUNT(*) pending,COALESCE(SUM(paused=1 OR extension_visible=0),0) restricted
      FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND status='pending'`).get(org,a.id)
    const reasons = [
      ...(!online?['offline']:[]), ...(a.paused?['server_paused']:[]),
      ...(consumer.state==='paused'?['consumer_paused']:consumer.state==='unknown'?['consumer_unknown']:[]),
      ...(capacity.blockedByDailyLimit?['daily_limit']:[]),
      ...(capacity.queuedToday>=capacity.dailyLimit?['queue_daily_limit']:[]),
      ...(capacity.retryAfterSeconds>0?['operational_interval']:[]),
    ]
    return { id:a.id,label:a.label,online,lastSeenAt:a.lastSeenAt,consumer,
      decision:latestConsumerDecision(db,org,a.id,now), reasons,queue,
      capacity:{used:capacity.used,queuedToday:capacity.queuedToday,dailyLimit:capacity.dailyLimit,
        remaining:capacity.remaining,nextAllowedAt:capacity.nextAllowedAt,retryAfterSeconds:capacity.retryAfterSeconds} }
  })
  const reviewWhere = "j.organization_id=? AND j.status IN ('awaiting_confirmation','error') AND (?=0 OR j.social_account_id=?) AND (?=0 OR j.vehicle_id=?)"
  const reviewArgs = [org,filters.accountId,filters.accountId,filters.vehicleId,filters.vehicleId]
  const reviewCount = (db.prepare('SELECT COUNT(*) count FROM publication_jobs j WHERE '+reviewWhere).get(...reviewArgs) as {count:number}).count
  const reviews = (db.prepare(`SELECT j.id,j.vehicle_id vehicleId,j.status,j.social_account_id accountId,j.publish_attempt_at publishAttemptAt,j.fill_report fillReport,
      j.paused,j.extension_visible visible,v.year || ' ' || v.make || ' ' || v.model title
      FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id AND v.organization_id=j.organization_id
      WHERE ${reviewWhere} ORDER BY j.updated_at DESC,j.id DESC LIMIT 100`).all(...reviewArgs) as Array<{
      id:number;vehicleId:number;status:string;accountId:number|null;publishAttemptAt:string|null;fillReport:string;paused:number;visible:number;title:string
    }>).map(j=>({id:j.id,vehicleId:j.vehicleId,status:j.status,accountId:j.accountId,title:j.title,
      paused:Boolean(j.paused),visible:Boolean(j.visible),reviewKind:publicationReviewKind(j)}))
  const types = filters.category==='all'?Object.values(eventGroups).flat():[...eventGroups[filters.category]]
  // Historical attribution uses only explicit event evidence, not the current job owner.
  const events = db.prepare(`WITH timeline AS (
      SELECT e.id,e.event_type eventType,e.created_at createdAt,j.id jobId,j.vehicle_id vehicleId,
        v.year || ' ' || v.make || ' ' || v.model title,
        e.from_account_id fromAccountId,e.to_account_id toAccountId,
        CASE WHEN json_valid(e.details) THEN CASE WHEN json_type(e.details,'$.accountId')='integer'
          THEN json_extract(e.details,'$.accountId') END END eventAccountId,
        CASE WHEN json_valid(e.details) THEN json_extract(e.details,'$.automatic')=1 ELSE 0 END automatic
      FROM publication_job_events e
      JOIN publication_jobs j ON j.id=e.publication_job_id AND j.organization_id=e.organization_id
      JOIN vehicles v ON v.id=j.vehicle_id AND v.organization_id=j.organization_id
      WHERE e.organization_id=? AND datetime(e.created_at)>=datetime('now',?)
        AND (?=0 OR e.id<?) AND (?=0 OR j.vehicle_id=?)
        AND e.event_type IN (${types.map(()=>'?').join(',')})
    )
    SELECT t.id,t.eventType,t.createdAt,t.jobId,t.vehicleId,t.title,t.automatic,
      a.id accountId,a.label accountLabel,src.id fromAccountId,src.label fromLabel,dst.id toAccountId,dst.label toLabel
    FROM timeline t
    LEFT JOIN social_accounts a ON a.id=t.eventAccountId AND a.organization_id=?
    LEFT JOIN social_accounts src ON src.id=t.fromAccountId AND src.organization_id=?
    LEFT JOIN social_accounts dst ON dst.id=t.toAccountId AND dst.organization_id=?
    WHERE (?=0 OR a.id=? OR src.id=? OR dst.id=?)
    ORDER BY t.id DESC LIMIT ?`).all(org,'-'+filters.hours+' hours',filters.beforeId,filters.beforeId,
      filters.vehicleId,filters.vehicleId,...types,org,org,org,filters.accountId,filters.accountId,filters.accountId,filters.accountId,filters.limit+1) as Array<{id:number;eventType:string;[key:string]:unknown}>
  return {timestamp:new Date(now).toISOString(),filters,profiles,reviews,reviewCount,activity:events.slice(0,filters.limit),
    nextBeforeId:events.length>filters.limit?events[filters.limit-1].id:null}
}
