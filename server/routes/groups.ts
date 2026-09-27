import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { curateMarketplaceGroups } from '../services/group-curator.ts'

type AuthContext = { userId: number; organizationId: number }
type Group = {
  id: number
  name: string
  url: string
  groupKey: string
  active: number
  priority: number
  successCount: number
  failureCount: number
  lastFoundAt?: string
}
type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  isAdmin: (auth: AuthContext) => boolean
  marketplaceGroups: (organizationId: number, activeOnly?: boolean) => Group[]
  groupTarget: (group: Pick<Group, 'name' | 'url'>) => string
}

export function handleGroupsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext,
  { db, send, isAdmin, marketplaceGroups, groupTarget }: Dependencies,
): boolean {
  if (req.method === 'GET' && url.pathname === '/api/groups/curated') {
    const locationQuery = String(url.searchParams.get('location') || '')
    const rawGroups = marketplaceGroups(auth.organizationId)
    const curated = curateMarketplaceGroups(rawGroups.map(group => ({ ...group, active: Boolean(group.active) })), locationQuery)
    send(res, 200, { ok: true, groups: curated })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/groups/auto-curate') {
    if (!isAdmin(auth)) {
      send(res, 403, { error: 'Somente administradores podem aplicar curadoria de grupos.' })
      return true
    }
    const rawGroups = marketplaceGroups(auth.organizationId)
    const curated = curateMarketplaceGroups(rawGroups.map(group => ({ ...group, active: Boolean(group.active) })), '', 10)
    db.exec('BEGIN')
    try {
      for (let index = 0; index < curated.length; index++) {
        const item = curated[index]
        db.prepare('UPDATE marketplace_groups SET priority = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?')
          .run(index + 1, item.recommendedActive ? 1 : 0, item.group.id, auth.organizationId)
      }
      const activeTargets = marketplaceGroups(auth.organizationId, true).map(groupTarget)
      db.prepare('UPDATE organization_settings SET target_groups = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?')
        .run(JSON.stringify(activeTargets), auth.organizationId)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    send(res, 200, { ok: true, curatedCount: curated.length, groups: marketplaceGroups(auth.organizationId) })
    return true
  }
  return false
}
