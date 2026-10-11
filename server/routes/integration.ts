import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import {
  integrationHasScope,
  readIntegrationAuth,
  type IntegrationAuth,
  type IntegrationScope,
} from '../services/integration-auth.ts'

type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  requestIdFor: (req: IncomingMessage) => string
}

function audit(
  db: DatabaseSync,
  auth: IntegrationAuth,
  req: IncomingMessage,
  action: string,
  outcome: 'allowed' | 'denied' | 'error',
) {
  db.prepare(
    `INSERT INTO integration_audit_events
      (organization_id,credential_id,actor_user_id,action,outcome,request_id)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    auth.organizationId,
    auth.credentialId,
    auth.createdBy,
    action,
    outcome,
    String(req.headers['x-request-id'] || '').slice(0, 200),
  )
}

function requireScope(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  send: Dependencies['send'],
  auth: IntegrationAuth,
  scope: IntegrationScope,
) {
  if (integrationHasScope(auth, scope)) return true
  audit(db, auth, req, scope, 'denied')
  send(res, 403, { error: 'A credencial da integração não possui este escopo.', requiredScope: scope })
  return false
}

export function isIntegrationRoute(url: URL) {
  return url.pathname === '/api/integration/v1' || url.pathname.startsWith('/api/integration/v1/')
}

export function handleIntegrationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  dependencies: Dependencies,
) {
  const { db, send } = dependencies
  if (!isIntegrationRoute(url)) return false
  if (req.method !== 'GET') {
    send(res, 405, { error: 'A primeira versão da Integration API é somente leitura.' })
    return true
  }
  const auth = readIntegrationAuth(db, req)
  if (!auth) {
    send(res, 401, { error: 'Credencial de integração inválida, expirada ou revogada.' })
    return true
  }
  if (url.pathname === '/api/integration/v1' || url.pathname === '/api/integration/v1/status') {
    if (!requireScope(db, req, res, send, auth, 'status:read')) return true
    audit(db, auth, req, 'status:read', 'allowed')
    send(res, 200, {
      status: 'ready',
      apiVersion: 'v1',
      integration: auth.name,
      readOnly: true,
      scopes: [...auth.scopes].sort(),
    })
    return true
  }
  if (url.pathname === '/api/integration/v1/vehicles') {
    if (!requireScope(db, req, res, send, auth, 'vehicles:read')) return true
    const vehicles = db
      .prepare(
        `SELECT v.id,v.stock_code stockCode,v.year,v.make,v.model,v.trim,v.price,v.km,
          v.status,v.location,v.updated_at updatedAt,
          (SELECT COUNT(*) FROM vehicle_images i
           WHERE i.organization_id=v.organization_id AND i.vehicle_id=v.id) photoCount
         FROM vehicles v WHERE v.organization_id=? ORDER BY v.updated_at DESC,v.id DESC LIMIT 250`,
      )
      .all(auth.organizationId)
    audit(db, auth, req, 'vehicles:read', 'allowed')
    send(res, 200, { vehicles })
    return true
  }
  if (url.pathname === '/api/integration/v1/publications') {
    if (!requireScope(db, req, res, send, auth, 'publications:read')) return true
    const jobs = db
      .prepare(
        `SELECT j.id,j.vehicle_id vehicleId,j.social_account_id accountId,j.status,
          j.retry_count retryCount,j.max_retries maxRetries,j.scheduled_at scheduledAt,
          j.result_url resultUrl,j.created_at createdAt,j.updated_at updatedAt
         FROM publication_jobs j WHERE j.organization_id=?
         ORDER BY j.updated_at DESC,j.id DESC LIMIT 250`,
      )
      .all(auth.organizationId)
    audit(db, auth, req, 'publications:read', 'allowed')
    send(res, 200, { jobs })
    return true
  }
  if (url.pathname === '/api/integration/v1/accounts') {
    if (!requireScope(db, req, res, send, auth, 'accounts:read')) return true
    const accounts = db
      .prepare(
        `SELECT id,label,connected,last_seen lastSeen,automation_paused automationPaused,
          daily_limit_override dailyLimitOverride,
          execution_interval_minutes_override executionIntervalMinutesOverride
         FROM social_accounts WHERE organization_id=? ORDER BY label,id`,
      )
      .all(auth.organizationId)
    audit(db, auth, req, 'accounts:read', 'allowed')
    send(res, 200, { accounts })
    return true
  }
  audit(db, auth, req, 'route:not_found', 'denied')
  send(res, 404, { error: 'Recurso não encontrado na Integration API.' })
  return true
}
