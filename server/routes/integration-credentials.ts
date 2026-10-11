import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { integrationReadScopes } from '../services/integration-auth.ts'

type Auth = { userId: number; organizationId: number }
type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  jsonBody: (req: IncomingMessage) => Promise<unknown>
  isAdmin: (auth: Auth) => boolean
}

export async function handleIntegrationCredentialsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: Auth,
  { db, send, jsonBody, isAdmin }: Dependencies,
) {
  const base = '/api/integrations/credentials'
  if (
    url.pathname !== base &&
    !/^\/api\/integrations\/credentials\/\d+\/revoke$/.test(url.pathname)
  )
    return false
  if (!isAdmin(auth)) {
    send(res, 403, { error: 'Apenas administradores podem gerenciar integrações.' })
    return true
  }
  if (url.pathname === base && req.method === 'GET') {
    const credentials = db
      .prepare(
        `SELECT id,name,scopes,active,expires_at expiresAt,last_used_at lastUsedAt,
        created_at createdAt,revoked_at revokedAt
       FROM integration_credentials WHERE organization_id=? ORDER BY id DESC`,
      )
      .all(auth.organizationId)
    send(res, 200, {
      credentials: credentials.map((row) => {
        const item = row as Record<string, unknown>
        return { ...item, scopes: JSON.parse(String(item.scopes)) }
      }),
    })
    return true
  }
  if (url.pathname === base && req.method === 'POST') {
    const input = await jsonBody(req)
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      send(res, 400, { error: 'Envie um objeto JSON com nome e escopos.' })
      return true
    }
    const body = input as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const scopes = body.scopes
    if (
      !name ||
      name.length > 100 ||
      !Array.isArray(scopes) ||
      scopes.length < 1 ||
      scopes.length > integrationReadScopes.length ||
      !scopes.every(
        (scope) =>
          typeof scope === 'string' &&
          integrationReadScopes.includes(scope as (typeof integrationReadScopes)[number]),
      ) ||
      new Set(scopes).size !== scopes.length
    ) {
      send(res, 400, { error: 'Nome ou escopos inválidos.' })
      return true
    }
    let expiresAt: string | null = null
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(body.expiresAt)) {
        send(res, 400, { error: 'Validade inválida.' })
        return true
      }
      const date = new Date(body.expiresAt)
      if (
        !Number.isFinite(date.getTime()) ||
        date.getTime() <= Date.now() ||
        date.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000
      ) {
        send(res, 400, { error: 'Validade deve estar no futuro, até 366 dias.' })
        return true
      }
      expiresAt = date.toISOString()
    }
    const token = 'afi_' + randomBytes(32).toString('base64url')
    const hash = createHash('sha256').update(token).digest('hex')
    const created = db
      .prepare(
        `INSERT INTO integration_credentials (organization_id,created_by,name,token_hash,scopes,expires_at)
       VALUES (?,?,?,?,?,?)`,
      )
      .run(auth.organizationId, auth.userId, name, hash, JSON.stringify(scopes), expiresAt)
    const id = Number(created.lastInsertRowid)
    db.prepare(
      `INSERT INTO integration_audit_events
       (organization_id,credential_id,actor_user_id,action,outcome)
       VALUES (?,?,?,'credential:create','allowed')`,
    ).run(auth.organizationId, id, auth.userId)
    res.setHeader('Cache-Control', 'no-store')
    send(res, 201, { id, name, scopes, expiresAt, token })
    return true
  }
  const match = /^\/api\/integrations\/credentials\/(\d+)\/revoke$/.exec(url.pathname)
  if (match && req.method === 'POST') {
    const id = Number(match[1])
    const updated = db
      .prepare(
        `UPDATE integration_credentials SET active=0,revoked_at=CURRENT_TIMESTAMP
       WHERE id=? AND organization_id=? AND active=1 AND revoked_at IS NULL`,
      )
      .run(id, auth.organizationId)
    if (!updated.changes) {
      send(res, 404, { error: 'Credencial ativa não encontrada.' })
      return true
    }
    db.prepare(
      `INSERT INTO integration_audit_events
       (organization_id,credential_id,actor_user_id,action,outcome)
       VALUES (?,?,?,'credential:revoke','allowed')`,
    ).run(auth.organizationId, id, auth.userId)
    send(res, 200, { revoked: true, id })
    return true
  }
  send(res, 405, { error: 'Método não permitido.' })
  return true
}
