import {
  applyGroupCuration,
  previewGroupCuration,
  undoLastGroupCuration,
} from '../services/group-curation-worker.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

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
  { db, send, isAdmin }: Dependencies,
): boolean {
  if (req.method === 'GET' && url.pathname === '/api/groups/curated') {
    // Ignore caller-supplied locations: only the company default is authoritative.
    const preview = previewGroupCuration(db, auth.organizationId)
    send(res, 200, { ok: true, ...preview })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/groups/auto-curate') {
    if (!isAdmin(auth)) {
      send(res, 403, { error: 'Somente administradores podem reorganizar grupos.' })
      return true
    }
    const digest = url.searchParams.get('previewDigest')
    if (!digest || !/^[a-f0-9]{64}$/.test(digest)) {
      send(res, 428, { error: 'Consulte e confirme a prévia antes de reorganizar.' })
      return true
    }
    try {
      const result = applyGroupCuration(db, auth.organizationId, digest)
      send(res, 200, { ok: true, ...result })
    } catch (error) {
      send(res, 409, {
        error: error instanceof Error ? error.message : 'A prévia está desatualizada.',
      })
    }
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/groups/undo-curation') {
    if (!isAdmin(auth)) {
      send(res, 403, { error: 'Somente administradores podem desfazer reorganizações.' })
      return true
    }
    try {
      send(res, 200, undoLastGroupCuration(db, auth.organizationId))
    } catch (error) {
      send(res, 409, { error: error instanceof Error ? error.message : 'Não é possível desfazer.' })
    }
    return true
  }
  return false
}
