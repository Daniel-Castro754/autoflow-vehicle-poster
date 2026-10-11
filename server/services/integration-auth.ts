import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'

export const integrationReadScopes = [
  'status:read',
  'vehicles:read',
  'publications:read',
  'accounts:read',
  'vehicles:create',
  'photos:write',
  'reports:read',
] as const

export type IntegrationScope = (typeof integrationReadScopes)[number]
export type IntegrationAuth = {
  credentialId: number
  organizationId: number
  createdBy: number | null
  name: string
  scopes: Set<string>
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function readIntegrationAuth(
  db: DatabaseSync,
  req: IncomingMessage,
): IntegrationAuth | null {
  const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim()
  if (!raw || !raw.startsWith('afi_') || raw.length < 32) return null
  const hash = tokenHash(raw)
  const row = db
    .prepare(
      `SELECT id,organization_id organizationId,created_by createdBy,name,token_hash tokenHash,scopes
       FROM integration_credentials
       WHERE token_hash=? AND active=1 AND revoked_at IS NULL
         AND (expires_at IS NULL OR datetime(expires_at)>CURRENT_TIMESTAMP)`,
    )
    .get(hash) as
    | {
        id: number
        organizationId: number
        createdBy: number | null
        name: string
        tokenHash: string
        scopes: string
      }
    | undefined
  if (!row) return null
  const a = Buffer.from(hash)
  const b = Buffer.from(row.tokenHash)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let scopes: string[] = []
  try {
    const parsed = JSON.parse(row.scopes)
    if (Array.isArray(parsed)) scopes = parsed.filter((item) => typeof item === 'string')
  } catch {
    return null
  }
  db.prepare('UPDATE integration_credentials SET last_used_at=CURRENT_TIMESTAMP WHERE id=?').run(
    row.id,
  )
  return {
    credentialId: row.id,
    organizationId: row.organizationId,
    createdBy: row.createdBy,
    name: row.name,
    scopes: new Set(scopes),
  }
}

export function integrationHasScope(auth: IntegrationAuth, scope: IntegrationScope) {
  return auth.scopes.has(scope)
}
