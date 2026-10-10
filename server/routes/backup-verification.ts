import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { listLocalBackups, verifyLocalBackup } from '../services/backup-verification.ts'

type Auth = { organizationId: number }
type Deps = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  jsonBody: (req: IncomingMessage) => Promise<unknown>
  isAdmin: boolean
}

/**
 * Host-wide backups contain every organization. Until per-tenant snapshots
 * exist, never allow an organization admin to verify host backups on a shared
 * installation. The list is available only in single-tenant installations.
 */
export async function handleBackupVerificationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _auth: Auth,
  { db, send, jsonBody, isAdmin }: Deps,
): Promise<boolean> {
  const list = url.pathname === '/api/health/backups'
  const verify = url.pathname === '/api/health/backups/verify'
  if (!list && !verify) return false
  res.setHeader('Cache-Control', 'no-store')
  if (!isAdmin) {
    send(res, 403, { error: 'Somente administradores podem verificar backups.' })
    return true
  }
  const orgs = db.prepare('SELECT COUNT(*) total FROM organizations').get() as { total: number }
  if (orgs.total !== 1) {
    send(res, 403, {
      error: 'Backups globais não estão disponíveis em ambientes com múltiplas empresas.',
    })
    return true
  }
  if (list && req.method === 'GET') {
    send(res, 200, listLocalBackups())
    return true
  }
  if (verify && req.method === 'POST') {
    const body = await jsonBody(req)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(res, 400, { error: 'Selecione uma cópia válida.' })
      return true
    }
    const candidate = (body as Record<string, unknown>).backupId
    if (typeof candidate !== 'string' || candidate.length > 100) {
      send(res, 400, { error: 'Identificador de cópia inválido.' })
      return true
    }
    const result = await verifyLocalBackup(candidate)
    if (!result.ok) send(res, result.status, { error: result.error })
    else send(res, 200, result.result)
    return true
  }
  send(res, 405, { error: 'Método não permitido para esta operação.' })
  return true
}
