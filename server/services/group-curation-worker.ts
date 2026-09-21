import type { DatabaseSync } from 'node:sqlite'
import { curateMarketplaceGroups, type GroupRecord } from './group-curator.ts'
import { logger } from '../lib/logger.ts'

function groupTarget(group: { name: string; url: string }) {
  return group.url ? `${group.name} | ${group.url}` : group.name
}

function listGroups(db: DatabaseSync, organizationId: number, activeOnly = false) {
  return db
    .prepare(`SELECT id,name,url,group_key groupKey,active,priority,success_count successCount,failure_count failureCount,last_found_at lastFoundAt
      FROM marketplace_groups WHERE organization_id=?${activeOnly ? ' AND active=1' : ''} ORDER BY priority,id`)
    .all(organizationId) as Array<{
      id: number; name: string; url: string; groupKey: string; active: number; priority: number
      successCount: number; failureCount: number; lastFoundAt?: string
    }>
}

/**
 * Aplica a curadoria (ativa/desativa e reordena por prioridade) sobre os grupos de uma
 * organização, a partir do histórico real de sucesso/falha já acumulado em fill-result.
 * Reaproveitada tanto pelo endpoint manual (POST /api/groups/auto-curate) quanto pelo
 * worker periódico abaixo.
 */
export function applyGroupCuration(db: DatabaseSync, organizationId: number) {
  const rawGroups = listGroups(db, organizationId)
  const curated = curateMarketplaceGroups(
    rawGroups.map(g => ({ ...g, active: Boolean(g.active) } as GroupRecord)),
    '',
    10
  )
  db.exec('BEGIN')
  try {
    for (let i = 0; i < curated.length; i++) {
      const item = curated[i]
      db.prepare('UPDATE marketplace_groups SET priority=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?')
        .run(i + 1, item.recommendedActive ? 1 : 0, item.group.id, organizationId)
    }
    const activeTargets = listGroups(db, organizationId, true).map(groupTarget)
    db.prepare('UPDATE organization_settings SET target_groups=?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=?')
      .run(JSON.stringify(activeTargets), organizationId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { curatedCount: curated.length, groups: listGroups(db, organizationId) }
}

/**
 * Varre todas as organizações com auto_curate_groups=1 e aplica a curadoria automaticamente,
 * sem exigir um clique manual no painel. Uma organização com falha não impede as demais.
 */
export function runGroupCurationSweep(db: DatabaseSync): { organizationsCurated: number } {
  const orgs = db
    .prepare('SELECT organization_id organizationId FROM organization_settings WHERE auto_curate_groups=1')
    .all() as Array<{ organizationId: number }>

  let organizationsCurated = 0
  for (const org of orgs) {
    try {
      applyGroupCuration(db, org.organizationId)
      organizationsCurated++
    } catch (err) {
      logger.warn('GroupCurationWorker', `Falha ao curar grupos da organização #${org.organizationId}`, { error: err })
    }
  }
  return { organizationsCurated }
}

let workerTimer: NodeJS.Timeout | null = null

export function startGroupCurationWorker(db: DatabaseSync, intervalMs = 21600000): void {
  if (workerTimer) return

  workerTimer = setInterval(() => {
    try {
      runGroupCurationSweep(db)
    } catch (err) {
      logger.warn('GroupCurationWorker', 'Erro na varredura periódica de curadoria', { error: err })
    }
  }, intervalMs)

  if (workerTimer && typeof workerTimer === 'object' && 'unref' in workerTimer) {
    workerTimer.unref()
  }
}

export function stopGroupCurationWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer)
    workerTimer = null
  }
}
