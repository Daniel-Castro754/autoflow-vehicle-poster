import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import {
  integrationHasScope,
  type IntegrationAuth,
} from '../services/integration-auth.ts'

type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
}

export function handleIntegrationMonthlyReport(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: IntegrationAuth,
  { db, send }: Dependencies,
): boolean {
  if (url.pathname !== '/api/integration/v1/reports/monthly') return false
  if (req.method !== 'GET') {
    send(res, 405, { error: 'Método não permitido.' })
    return true
  }
  if (!integrationHasScope(auth, 'reports:read')) {
    send(res, 403, { error: 'Escopo reports:read obrigatório.' })
    return true
  }
  const month = url.searchParams.get('month') || ''
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    send(res, 400, { error: 'Informe month no formato AAAA-MM.' })
    return true
  }
  const start = month + '-01'
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1))
    .toISOString()
    .slice(0, 10)
  const publication = db
    .prepare(
      `SELECT COUNT(*) total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='canceled' THEN 1 ELSE 0 END) canceled
       FROM publication_jobs
       WHERE organization_id=? AND created_at>=? AND created_at<?`,
    )
    .get(auth.organizationId, start, end) as Record<string, number | null>
  const vehicles = db
    .prepare(
      `SELECT COUNT(*) total,
        SUM(CASE WHEN status='Rascunho' THEN 1 ELSE 0 END) drafts,
        SUM(CASE WHEN status='Publicado' THEN 1 ELSE 0 END) published,
        SUM(CASE WHEN status='Vendido' THEN 1 ELSE 0 END) sold
       FROM vehicles WHERE organization_id=?`,
    )
    .get(auth.organizationId) as Record<string, number | null>
  db.prepare(
    `INSERT INTO integration_audit_events
      (organization_id,credential_id,actor_user_id,action,outcome)
      VALUES (?,?,?,'reports:read','allowed')`,
  ).run(auth.organizationId, auth.credentialId, auth.createdBy)
  send(res, 200, {
    month,
    period: { start, endExclusive: end },
    publicationJobsCreatedInMonth: {
      total: publication.total || 0,
      completedCurrentStatus: publication.completed || 0,
      failedCurrentStatus: publication.failed || 0,
      canceledCurrentStatus: publication.canceled || 0,
    },
    currentInventorySnapshot: {
      total: vehicles.total || 0,
      drafts: vehicles.drafts || 0,
      published: vehicles.published || 0,
      sold: vehicles.sold || 0,
    },
    notes: [
      'Os status dos jobs representam a situação atual de jobs criados no mês, não eventos ocorridos no mês.',
      'O estoque é um retrato atual, não um fechamento histórico do mês.',
    ],
  })
  return true
}
