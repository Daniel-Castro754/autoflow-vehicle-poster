import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { operationalHealth, prometheusMetrics } from '../services/operational-health.ts'

export function handleOperationsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: { organizationId: number },
  db: DatabaseSync,
  send: (res: ServerResponse, status: number, data: unknown) => void,
): boolean {
  if (req.method !== 'GET' || !['/api/health/detailed', '/api/metrics'].includes(url.pathname))
    return false
  const report = operationalHealth(db, auth.organizationId)
  res.setHeader('Cache-Control', 'no-store')
  if (url.pathname === '/api/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
    res.end(prometheusMetrics(report))
  } else send(res, 200, { ok: true, ...report })
  return true
}
