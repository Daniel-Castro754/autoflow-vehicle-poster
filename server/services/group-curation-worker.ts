import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { curateMarketplaceGroups, type GroupRecord } from './group-curator.ts'
import { logger } from '../lib/logger.ts'

function groupTarget(group: { name: string; url: string }) {
  return group.url ? `${group.name} | ${group.url}` : group.name
}

function listGroups(db: DatabaseSync, organizationId: number, activeOnly = false) {
  return db
    .prepare(
      `SELECT id,name,url,group_key groupKey,active,priority,success_count successCount,failure_count failureCount,last_found_at lastFoundAt,city,state,member_count memberCount
      FROM marketplace_groups WHERE organization_id=?${activeOnly ? ' AND active=1' : ''} ORDER BY priority,id`,
    )
    .all(organizationId) as Array<{
    id: number
    name: string
    url: string
    groupKey: string
    active: number
    priority: number
    successCount: number
    failureCount: number
    lastFoundAt?: string
    city?: string
    state?: string
    memberCount?: number
  }>
}

type RankedGroup = ReturnType<typeof listGroups>[number]

function rankingInput(db: DatabaseSync, organizationId: number) {
  const groups = listGroups(db, organizationId)
  const company = db
    .prepare('SELECT default_location location FROM organization_settings WHERE organization_id=?')
    .get(organizationId) as { location: string } | undefined
  const location = company?.location || ''
  return { groups, location }
}

function rankingDigest(groups: RankedGroup[], location: string) {
  return createHash('sha256')
    .update(JSON.stringify({ location, groups: [...groups].sort((a, b) => a.id - b.id) }))
    .digest('hex')
}

function rank(groups: RankedGroup[], location: string) {
  return curateMarketplaceGroups(
    groups.map((group) => ({ ...group, active: Boolean(group.active) }) as GroupRecord),
    location,
    20,
  )
}

/** Read-only preview. The stock ID, active status and membership never change here. */
export function previewGroupCuration(db: DatabaseSync, organizationId: number) {
  const { groups, location } = rankingInput(db, organizationId)
  const curated = rank(groups, location)
  const changedOrder = curated.filter((item, index) => item.group.priority !== index + 1).length
  return {
    groups: curated,
    total: groups.length,
    activeCount: groups.filter((group) => Boolean(group.active)).length,
    previewDigest: rankingDigest(groups, location),
    changedOrder,
    location,
  }
}

/**
 * Reorders ONLY priorities. "active" and group identities are never changed by
 * a ranking operation; selection of at most 20 is a separate publication concern.
 * Runs atomically and writes a reversible snapshot on every effective change.
 */
export function applyGroupCuration(
  db: DatabaseSync,
  organizationId: number,
  expectedDigest?: string,
  source: 'manual' | 'automatic' = 'manual',
) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const { groups, location } = rankingInput(db, organizationId)
    const digest = rankingDigest(groups, location)
    if (expectedDigest !== undefined && expectedDigest !== digest)
      throw new Error('A lista de grupos mudou após a prévia. Atualize e tente novamente.')

    const curated = rank(groups, location)
    const changedOrder = curated.some((item, index) => item.group.priority !== index + 1)
    if (changedOrder) {
      const previousTargets = db
        .prepare('SELECT target_groups targets FROM organization_settings WHERE organization_id=?')
        .get(organizationId) as { targets: string } | undefined
      const snapshot = {
        groups: groups.map((group) => ({
          id: group.id,
          priority: group.priority,
          active: group.active,
        })),
        targetGroups: previousTargets?.targets || '[]',
      }
      for (const [index, item] of curated.entries()) {
        db.prepare(
          'UPDATE marketplace_groups SET priority=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?',
        ).run(index + 1, item.group.id, organizationId)
      }
      const activeTargets = listGroups(db, organizationId, true).slice(0, 20).map(groupTarget)
      db.prepare(
        'UPDATE organization_settings SET target_groups=?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=?',
      ).run(JSON.stringify(activeTargets), organizationId)
      const after = rankingInput(db, organizationId)
      db.prepare(
        'INSERT INTO group_curation_history (organization_id,before_state,after_digest,source) VALUES (?,?,?,?)',
      ).run(
        organizationId,
        JSON.stringify(snapshot),
        rankingDigest(after.groups, after.location),
        source,
      )
    }
    db.exec('COMMIT')
    return {
      curatedCount: curated.length,
      changedOrder: changedOrder ? 1 : 0,
      groups: listGroups(db, organizationId),
    }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Restore only the most recent ranking, if no one has edited the group list since. */
export function undoLastGroupCuration(db: DatabaseSync, organizationId: number) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const history = db
      .prepare(
        'SELECT id,before_state beforeState,after_digest afterDigest FROM group_curation_history WHERE organization_id=? AND undone_at IS NULL ORDER BY id DESC LIMIT 1',
      )
      .get(organizationId) as { id: number; beforeState: string; afterDigest: string } | undefined
    if (!history) throw new Error('Não há reorganização anterior para desfazer.')
    const current = rankingInput(db, organizationId)
    if (rankingDigest(current.groups, current.location) !== history.afterDigest)
      throw new Error(
        'A lista foi modificada desde a reorganização. Não é seguro desfazer automaticamente.',
      )
    const before = JSON.parse(history.beforeState) as {
      groups: Array<{ id: number; priority: number; active: number }>
      targetGroups: string
    }
    if (
      before.groups.length !== current.groups.length ||
      before.groups.some((group) => !current.groups.some((item) => item.id === group.id))
    )
      throw new Error('Os grupos mudaram. Não é seguro desfazer.')
    for (const group of before.groups) {
      db.prepare('UPDATE marketplace_groups SET priority=? WHERE id=? AND organization_id=?').run(
        group.priority,
        group.id,
        organizationId,
      )
    }
    db.prepare(
      'UPDATE organization_settings SET target_groups=?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=?',
    ).run(before.targetGroups, organizationId)
    db.prepare(
      'UPDATE group_curation_history SET undone_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?',
    ).run(history.id, organizationId)
    db.exec('COMMIT')
    return { ok: true, groups: listGroups(db, organizationId) }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Varre todas as organizações com auto_curate_groups=1 e aplica a curadoria automaticamente,
 * sem exigir um clique manual no painel. Uma organização com falha não impede as demais.
 */
export function runGroupCurationSweep(db: DatabaseSync): { organizationsCurated: number } {
  const orgs = db
    .prepare(
      'SELECT organization_id organizationId FROM organization_settings WHERE auto_curate_groups=1',
    )
    .all() as Array<{ organizationId: number }>

  let organizationsCurated = 0
  for (const org of orgs) {
    try {
      const confirmed = (
        db
          .prepare(
            "SELECT COUNT(*) total FROM publication_jobs WHERE organization_id=? AND status='completed'",
          )
          .get(org.organizationId) as { total: number }
      ).total
      const last = db
        .prepare('SELECT confirmed_count count FROM group_ranking_refresh WHERE organization_id=?')
        .get(org.organizationId) as { count: number } | undefined
      // Reevaluate rankings after every ten newly confirmed publications.
      if (confirmed - (last?.count || 0) < 10) continue
      applyGroupCuration(db, org.organizationId, undefined, 'automatic')
      db.prepare(
        `INSERT INTO group_ranking_refresh (organization_id,confirmed_count,refreshed_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(organization_id) DO UPDATE SET
        confirmed_count=excluded.confirmed_count,refreshed_at=CURRENT_TIMESTAMP`,
      ).run(org.organizationId, confirmed)
      organizationsCurated++
    } catch (err) {
      logger.warn(
        'GroupCurationWorker',
        `Falha ao curar grupos da organização #${org.organizationId}`,
        { error: err },
      )
    }
  }
  return { organizationsCurated }
}

let workerTimer: NodeJS.Timeout | null = null

export function startGroupCurationWorker(db: DatabaseSync, intervalMs = 60000): void {
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
