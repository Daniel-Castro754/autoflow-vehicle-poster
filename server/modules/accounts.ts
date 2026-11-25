import type { DatabaseSync } from 'node:sqlite'
import { consumerState } from '../services/execution-diagnostics.ts'

// Shared account selection, independent of Facebook extension transport.

export interface AvailableAccount {
  id: number
  label: string
  browserProfile?: string
  status: string
  lastSeenAt?: string
  todayCount: number
  dailyLimit: number
  score: number
  pendingCount?: number
  consumer?: string
}

export type RoutingMode = 'default' | 'autopilot_manual' | 'autopilot_recurring'

export function consumerRoutingEligible(state: string, mode: RoutingMode) {
  return mode === 'default' || state === 'enabled' ||
    (mode === 'autopilot_manual' && state === 'unknown')
}

export function findBestAccountForVehicle(
  db: DatabaseSync,
  organizationId: number,
  vehicleId: number,
  mode: RoutingMode = 'default',
): AvailableAccount | null {
  const settings = db
    .prepare('SELECT daily_limit dailyLimit FROM organization_settings WHERE organization_id = ?')
    .get(organizationId) as { dailyLimit?: number } | undefined
  const dailyLimit = Number(settings?.dailyLimit || 10)

  // Seleciona todas as contas da organização
  const accounts = db
    .prepare(
      `
      SELECT a.id, a.label, a.browser_profile browserProfile, a.status, a.last_seen_at lastSeenAt,
        MIN(COALESCE(a.daily_limit_override,?),?) profileDailyLimit,
        COALESCE((
          SELECT COUNT(*) FROM publication_jobs j
          WHERE j.organization_id = a.organization_id AND j.social_account_id = a.id
            AND autoflow_day(j.created_at) = autoflow_day(CURRENT_TIMESTAMP)
            AND j.status != 'canceled'
        ), 0) todayCount,
        (SELECT COUNT(*) FROM publication_jobs backlog WHERE backlog.organization_id=a.organization_id
          AND backlog.social_account_id=a.id AND backlog.status IN ('pending','filling','error','awaiting_confirmation')) pendingCount,
        EXISTS (SELECT 1 FROM publication_jobs busy WHERE busy.organization_id=a.organization_id
          AND busy.social_account_id=a.id AND busy.vehicle_id=?
          AND busy.status IN ('pending','filling','error','awaiting_confirmation')) busy
      FROM social_accounts a
      WHERE a.organization_id = ? AND a.status = 'connected' AND COALESCE(a.automation_paused,0)=0
        AND a.last_seen_at IS NOT NULL AND datetime(a.last_seen_at)>=datetime('now','-5 minutes')
      ORDER BY a.label
    `,
    )
    .all(dailyLimit, dailyLimit, vehicleId, organizationId) as Array<{
    id: number
    label: string
    browserProfile?: string
    status: string
    lastSeenAt?: string
    todayCount: number
    profileDailyLimit: number
    busy: number
    pendingCount: number
  }>

  if (!accounts.length) return null

  // Filtra contas elegíveis (com espaço no limite diário e sem job ativo para o veículo)
  const eligible: AvailableAccount[] = []

  for (const acc of accounts) {
    const limit = Math.max(1, Number(acc.profileDailyLimit) || dailyLimit)
    if (acc.todayCount >= limit) continue

    if (acc.busy) continue
    const consumer = consumerState(db, organizationId, acc.id).state
    if (!consumerRoutingEligible(consumer, mode)) continue

    // Calcula score: menor volume hoje e maior recência ganham prioridade
    const capacityRemaining = limit - acc.todayCount
    let recencyScore = 0
    if (acc.lastSeenAt) {
      const elapsed =
        Date.now() -
        Date.parse(
          /(?:Z|[+-]\d\d:\d\d)$/.test(acc.lastSeenAt)
            ? acc.lastSeenAt
            : acc.lastSeenAt.replace(' ', 'T') + 'Z',
        )
      if (elapsed < 15 * 60000) recencyScore = 20
      else if (elapsed < 60 * 60000) recencyScore = 10
    }

    const score = capacityRemaining * 10 + recencyScore
    eligible.push({
      ...acc,
      dailyLimit: limit,
      score,
      consumer,
    })
  }

  if (!eligible.length) return null
  eligible.sort((a, b) => {
    if (mode !== 'default') {
      // Prefer an explicitly active consumer, then balance all outstanding work,
      // including jobs created on earlier dates. Keep deterministic tie breaking.
      const active = Number(b.consumer === 'enabled') - Number(a.consumer === 'enabled')
      if (active) return active
      const backlog = (a.pendingCount ?? 0) - (b.pendingCount ?? 0)
      if (backlog) return backlog
    }
    return b.score - a.score || a.id - b.id
  })
  return eligible[0]
}
