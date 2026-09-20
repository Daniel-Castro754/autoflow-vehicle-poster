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
  vehicleId: number
): AvailableAccount | null {
  const settings = db
    .prepare('SELECT daily_limit dailyLimit FROM organization_settings WHERE organization_id = ?')
    .get(organizationId) as { dailyLimit?: number } | undefined
  const dailyLimit = Number(settings?.dailyLimit || 10)

  // Seleciona todas as contas da organização
  const accounts = db
    .prepare(`
      SELECT a.id, a.label, a.browser_profile browserProfile, a.status, a.last_seen_at lastSeenAt,
        COALESCE((
          SELECT COUNT(*) FROM publication_jobs j
          WHERE j.organization_id = a.organization_id AND j.social_account_id = a.id
            AND date(j.created_at, 'localtime') = date('now', 'localtime')
            AND j.status != 'canceled'
        ), 0) todayCount
      FROM social_accounts a
      WHERE a.organization_id = ?
      ORDER BY a.label
    `)
    .all(organizationId) as Array<{
      id: number
      label: string
      browserProfile?: string
      status: string
      lastSeenAt?: string
      todayCount: number
    }>

  if (!accounts.length) return null

  // Filtra contas elegíveis (com espaço no limite diário e sem job ativo para o veículo)
  const eligible: AvailableAccount[] = []

  for (const acc of accounts) {
    if (acc.todayCount >= dailyLimit) continue

    // Checa se esta conta já possui trabalho ativo para o mesmo veículo
    const existingJob = db
      .prepare(`
        SELECT id FROM publication_jobs
        WHERE organization_id = ? AND social_account_id = ? AND vehicle_id = ?
          AND status IN ('pending', 'filling', 'error', 'awaiting_confirmation')
        LIMIT 1
      `)
      .get(organizationId, acc.id, vehicleId)

    if (existingJob) continue

    // Calcula score: menor volume hoje e maior recência ganham prioridade
    const capacityRemaining = dailyLimit - acc.todayCount
    let recencyScore = 0
    if (acc.lastSeenAt) {
      const elapsed = Date.now() - new Date(acc.lastSeenAt.replace(' ', 'T') + 'Z').getTime()
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
