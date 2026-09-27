import { applyGroupCuration } from '../services/group-curation-worker.ts'
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
  { db, send, isAdmin, marketplaceGroups }: Dependencies,
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
    const result = applyGroupCuration(db, auth.organizationId)
    send(res, 200, { ok: true, ...result })
    return true
  }
  return false
}
