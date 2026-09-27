import type { DatabaseSync } from 'node:sqlite'

export interface AvailableAccount {
  id: number
  label: string
  browserProfile?: string
  status: string
  lastSeenAt?: string
  todayCount: number
  dailyLimit: number
  score: number
}

export function findBestAccountForVehicle(
  db: DatabaseSync,
  organizationId: number,
  vehicleId: number,
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
        COALESCE((
          SELECT COUNT(*) FROM publication_jobs j
          WHERE j.organization_id = a.organization_id AND j.social_account_id = a.id
            AND autoflow_day(j.created_at) = autoflow_day(CURRENT_TIMESTAMP)
            AND j.status != 'canceled'
        ), 0) todayCount,
        EXISTS (SELECT 1 FROM publication_jobs busy WHERE busy.organization_id=a.organization_id
          AND busy.social_account_id=a.id AND busy.vehicle_id=?
          AND busy.status IN ('pending','filling','error','awaiting_confirmation')) busy
      FROM social_accounts a
      WHERE a.organization_id = ? AND a.status = 'connected'
      ORDER BY a.label
    `,
    )
    .all(vehicleId, organizationId) as Array<{
    id: number
    label: string
    browserProfile?: string
    status: string
    lastSeenAt?: string
    todayCount: number
    busy: number
  }>

  if (!accounts.length) return null

  // Filtra contas elegíveis (com espaço no limite diário e sem job ativo para o veículo)
  const eligible: AvailableAccount[] = []

  for (const acc of accounts) {
    if (acc.todayCount >= dailyLimit) continue

    if (acc.busy) continue

    // Calcula score: menor volume hoje e maior recência ganham prioridade
    const capacityRemaining = dailyLimit - acc.todayCount
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
      dailyLimit,
      score,
    })
  }

  if (!eligible.length) return null
  eligible.sort((a, b) => b.score - a.score)
  return eligible[0]
}
