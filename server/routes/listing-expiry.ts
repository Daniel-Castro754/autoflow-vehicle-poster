import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { listingExpiryOverview } from '../services/listing-expiry.ts'

type Auth = { userId: number; organizationId: number }
type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  jsonBody: (req: IncomingMessage) => Promise<unknown>
  isAdmin: (auth: Auth) => boolean
  canManageJobs: (ids: number[], auth: Auth) => boolean
  recordJobEvent: (
    organizationId: number,
    jobId: number,
    eventType: string,
    createdBy?: number | null,
    details?: Record<string, unknown>,
  ) => void
}

export async function handleListingExpiryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: Auth,
  { db, send, jsonBody, isAdmin, canManageJobs, recordJobEvent }: Dependencies,
) {
  const base = '/api/publications/listing-expiry'
  const extension = /^\/api\/publications\/(\d+)\/extend-listing-expiry$/.exec(url.pathname)
  if (url.pathname !== base && !extension) return false
  const admin = isAdmin(auth)
  if (url.pathname === base && req.method === 'GET') {
    const page = Number(url.searchParams.get('page') || 1)
    if (!Number.isSafeInteger(page) || page < 1) {
      send(res, 400, { error: 'Página inválida.' })
      return true
    }
    const { policy, items } = listingExpiryOverview(
      db,
      auth.organizationId,
      admin ? null : auth.userId,
    )
    const counts = { total: items.length, sold: 0, expired: 0, warning: 0, review: 0 }
    for (const item of items) {
      if (item.state === 'sold') counts.sold++
      if (item.state === 'expired') counts.expired++
      if (item.state === 'warning') counts.warning++
      if (item.state === 'review') counts.review++
    }
    const pages = Math.max(1, Math.ceil(items.length / 25))
    const currentPage = Math.min(page, pages)
    send(res, 200, {
      policy,
      canConfigure: admin,
      counts,
      items: items.slice((currentPage - 1) * 25, currentPage * 25),
      page: currentPage,
      pages,
    })
    return true
  }
  if (url.pathname === base && req.method === 'PATCH') {
    if (!admin) {
      send(res, 403, { error: 'Somente administradores podem configurar a validade.' })
      return true
    }
    const raw = await jsonBody(req)
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const { enabled, days, warning } = body
    if (
      typeof enabled !== 'boolean' ||
      typeof warning !== 'boolean' ||
      typeof days !== 'number' ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 90
    ) {
      send(res, 400, { error: 'Informe uma validade de 1 a 90 dias e opções válidas.' })
      return true
    }
    db.prepare(
      `UPDATE organization_settings SET listing_expiry_enabled=?,listing_expiry_days=?,
        listing_expiry_warning=? WHERE organization_id=?`,
    ).run(Number(enabled), days, Number(warning), auth.organizationId)
    send(res, 200, { ok: true })
    return true
  }
  if (extension && req.method === 'PATCH') {
    const jobId = Number(extension[1])
    if (!Number.isSafeInteger(jobId) || !canManageJobs([jobId], auth)) {
      send(res, 403, { error: 'Publicação não autorizada.' })
      return true
    }
    const raw = await jsonBody(req)
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const days = body.days
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 30) {
      send(res, 400, { error: 'A prorrogação deve ser de 1 a 30 dias.' })
      return true
    }
    const now = Date.now()
    const item = listingExpiryOverview(
      db,
      auth.organizationId,
      admin ? null : auth.userId,
      now,
    ).items.find((entry) => entry.jobId === jobId)
    if (!item?.canExtend || !item.expiresAt) {
      send(res, 409, { error: 'Este anúncio não pode ser prorrogado.' })
      return true
    }
    const expiresAt = new Date(
      Math.max(now, Date.parse(item.expiresAt)) + days * 86_400_000,
    ).toISOString()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `UPDATE publication_listing_ledger SET expiry_review_until=?
          WHERE organization_id=? AND publication_job_id=? AND status='active'`,
      ).run(expiresAt, auth.organizationId, jobId)
      recordJobEvent(auth.organizationId, jobId, 'listing_expiry_extended', auth.userId, {
        days,
        expiresAt,
      })
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    send(res, 200, { ok: true, expiresAt })
    return true
  }
  send(res, 405, { error: 'Método não permitido.' })
  return true
}
