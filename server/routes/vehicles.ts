import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyVehicleDefaults, validImageContent, validateVehicleBody } from '../services/vehicle-input.ts'

type AuthContext = { userId: number; organizationId: number }
type Dependencies = {
  send: (res: ServerResponse, status: number, data: unknown) => void
  imageBaseUrl: string
  validStatuses: Set<string>
  pageStatements: VehiclePageStatements
}
type MutationDependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  jsonBody: (req: IncomingMessage, maxBytes?: number) => Promise<unknown>
  imageBaseUrl: string
  uploadsDir: string
  isAdmin: (auth: AuthContext) => boolean
  canWriteVehicle: (vehicleId: number, auth: AuthContext) => boolean
  canWriteImage: (imageId: number, auth: AuthContext) => boolean
  recordJobEvent: (organizationId: number, jobId: number, eventType: string, createdBy?: number | null, details?: Record<string, unknown>) => void
}
const IMAGE_UPLOAD_BODY_LIMIT = 17 * 1024 * 1024
const terminalVehicleStatuses = new Set(['Publicado', 'Vendido'])

type VehiclePageStatements = { count: StatementSync; list: StatementSync; all: StatementSync; summary: StatementSync }

const vehicleSelect = `SELECT v.id,v.year,v.make,v.model,v.trim,v.price,v.km,v.color,v.status,
  v.vehicle_type vehicleType,v.location,v.transmission,v.fuel_type fuelType,v.body_type bodyType,
  v.exterior_color exteriorColor,v.interior_color interiorColor,v.vehicle_condition condition,v.description,v.sold_at soldAt,
  COALESCE(u.name,'Não atribuído') seller,
  CASE WHEN u.name IS NULL THEN '—' ELSE substr(u.name,1,1)||substr(u.name,instr(u.name,' ')+1,1) END initials,
  v.updated_at updatedAt,(SELECT COUNT(*) FROM vehicle_images i WHERE i.vehicle_id=v.id) imageCount,
  (SELECT ?||i.file_name FROM vehicle_images i WHERE i.vehicle_id=v.id ORDER BY i.position,i.id LIMIT 1) thumbnailUrl,
  (SELECT COUNT(*) FROM publication_jobs j WHERE j.vehicle_id=v.id AND j.status='completed') pendingRemovalCount
  FROM vehicles v LEFT JOIN users u ON u.id=v.assigned_user_id`

export function createVehiclePageStatements(db: DatabaseSync): VehiclePageStatements {
  return {
    count: db.prepare(`SELECT COUNT(*) total FROM vehicles v LEFT JOIN users u ON u.id=v.assigned_user_id
      WHERE v.organization_id=? AND (?='' OR lower(v.make||' '||v.model||' '||CAST(v.year AS TEXT)||' '||COALESCE(u.name,'')) LIKE '%'||lower(?)||'%')
      AND (?='Todos' OR v.status=?)`),
    list: db.prepare(`${vehicleSelect}
      WHERE v.organization_id=? AND (?='' OR lower(v.make||' '||v.model||' '||CAST(v.year AS TEXT)||' '||COALESCE(u.name,'')) LIKE '%'||lower(?)||'%')
      AND (?='Todos' OR v.status=?) ORDER BY v.updated_at DESC,v.id DESC LIMIT ? OFFSET ?`),
    all: db.prepare(`${vehicleSelect} WHERE v.organization_id=? ORDER BY v.updated_at DESC`),
    summary: db.prepare(`WITH inventory AS (
      SELECT v.status,v.price,COALESCE(u.name,'Não atribuído') seller,
        (SELECT COUNT(*) FROM vehicle_images i WHERE i.vehicle_id=v.id AND i.organization_id=v.organization_id) imageCount
      FROM vehicles v LEFT JOIN users u ON u.id=v.assigned_user_id WHERE v.organization_id=?
    )
    SELECT seller,COUNT(*) total,COALESCE(SUM(price),0) inventoryValue,
      SUM(CASE WHEN status='Publicado' THEN 1 ELSE 0 END) published,
      SUM(CASE WHEN status='Atenção' THEN 1 ELSE 0 END) attention,
      SUM(CASE WHEN imageCount>0 THEN 1 ELSE 0 END) withPhotos,
      SUM(CASE WHEN status='Publicado' THEN 1 ELSE 0 END) publishedStatus,
      SUM(CASE WHEN status='Pronto' THEN 1 ELSE 0 END) readyStatus,
      SUM(CASE WHEN status='Rascunho' THEN 1 ELSE 0 END) draftStatus,
      SUM(CASE WHEN status='Atenção' THEN 1 ELSE 0 END) attentionStatus,
      SUM(CASE WHEN status='Vendido' THEN 1 ELSE 0 END) soldStatus,
      SUM(CASE WHEN imageCount=0 THEN 1 ELSE 0 END) noPhotos,
      SUM(CASE WHEN imageCount BETWEEN 1 AND 4 THEN 1 ELSE 0 END) photos1to4,
      SUM(CASE WHEN imageCount BETWEEN 5 AND 9 THEN 1 ELSE 0 END) photos5to9,
      SUM(CASE WHEN imageCount>=10 THEN 1 ELSE 0 END) photos10plus
    FROM inventory GROUP BY seller ORDER BY seller`),
  }
}

export function handleVehicleReadRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext,
  { send, imageBaseUrl, validStatuses, pageStatements }: Dependencies,
): boolean {
  if (req.method === 'GET' && url.pathname === '/api/vehicles/paged') {
    const pageRaw = Number(url.searchParams.get('page') || 1)
    const pageSizeRaw = Number(url.searchParams.get('limit') || 25)
    if (!Number.isInteger(pageRaw) || pageRaw < 1 || !Number.isInteger(pageSizeRaw) || pageSizeRaw < 1) {
      send(res, 400, { error: 'Parâmetros de paginação inválidos.' })
      return true
    }
    const pageSize = Math.min(100, pageSizeRaw)
    const query = String(url.searchParams.get('query') || '').trim().slice(0, 100)
    const status = String(url.searchParams.get('status') || 'Todos')
    if (status !== 'Todos' && !validStatuses.has(status)) {
      send(res, 400, { error: 'Status de veículo inválido.' })
      return true
    }
    const total = Number((pageStatements.count.get(auth.organizationId, query, query, status, status) as { total: number }).total)
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const currentPage = Math.min(pageRaw, totalPages)
    const offset = (currentPage - 1) * pageSize
    const vehicles = pageStatements.list.all(imageBaseUrl, auth.organizationId, query, query, status, status, pageSize, offset)
    send(res, 200, { vehicles, pagination: { totalItems: total, totalPages, currentPage, pageSize } })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/vehicles/summary') {
    const sellers = pageStatements.summary.all(auth.organizationId) as Array<Record<string, unknown>>
    const totals = sellers.reduce((total, seller) => {
      for (const key of ['total','inventoryValue','published','attention','withPhotos','publishedStatus','readyStatus','draftStatus','attentionStatus','soldStatus','noPhotos','photos1to4','photos5to9','photos10plus']) {
        total[key] = Number(total[key] || 0) + Number(seller[key] || 0)
      }
      return total
    }, {} as Record<string, number>)
    send(res, 200, { ...totals, sellers: sellers.map(({ seller, ...summary }) => ({ name: seller, ...summary })) })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/vehicles') {
    const rows = pageStatements.all.all(imageBaseUrl, auth.organizationId)
    send(res, 200, { vehicles: rows })
    return true
  }
  return false
}

export async function handleVehicleMutationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext,
  { db, send, jsonBody, imageBaseUrl, uploadsDir, isAdmin, canWriteVehicle, canWriteImage, recordJobEvent }: MutationDependencies,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/api/vehicles') {
    const body = await jsonBody(req) as Record<string, unknown>
    const vehicleInput = applyVehicleDefaults(db, body, auth.organizationId)
    const validationError = validateVehicleBody(vehicleInput)
    if (validationError) {
      send(res, 400, { error: validationError })
      return true
    }
    if (terminalVehicleStatuses.has(String(vehicleInput.status || 'Rascunho'))) {
      send(res, 409, { error: 'Use os fluxos de publicação ou venda para definir este status.' })
      return true
    }
    const result = db.prepare(`INSERT INTO vehicles (organization_id,year,make,model,trim,price,km,status,assigned_user_id,vehicle_type,location,transmission,fuel_type,body_type,exterior_color,interior_color,vehicle_condition,description)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(auth.organizationId, Number(vehicleInput.year), String(vehicleInput.make), String(vehicleInput.model).trim(), String(vehicleInput.trim || ''), Number(vehicleInput.price), Number(vehicleInput.km), String(vehicleInput.status || 'Rascunho'), auth.userId, String(vehicleInput.vehicleType), String(vehicleInput.location).trim(), String(vehicleInput.transmission), String(vehicleInput.fuelType), String(vehicleInput.bodyType), String(vehicleInput.exteriorColor), String(vehicleInput.interiorColor), String(vehicleInput.condition), String(vehicleInput.description).trim())
    send(res, 201, { id: Number(result.lastInsertRowid) })
    return true
  }

  const vehicleRoute = url.pathname.match(/^\/api\/vehicles\/(\d+)$/)
  if (req.method === 'PATCH' && vehicleRoute) {
    const vehicleId = Number(vehicleRoute[1])
    const body = await jsonBody(req) as Record<string, unknown>
    if (!canWriteVehicle(vehicleId, auth)) {
      send(res, 403, { error: 'Você não pode alterar este veículo.' })
      return true
    }
    const currentVehicle = db.prepare('SELECT status FROM vehicles WHERE id=? AND organization_id=?').get(vehicleId, auth.organizationId) as { status: string }
    const vehicleInput = applyVehicleDefaults(db, body, auth.organizationId)
    const validationError = validateVehicleBody(vehicleInput)
    if (validationError) {
      send(res, 400, { error: validationError })
      return true
    }
    const requestedStatus = String(vehicleInput.status || 'Rascunho')
    if ((terminalVehicleStatuses.has(currentVehicle.status) || terminalVehicleStatuses.has(requestedStatus)) && requestedStatus !== currentVehicle.status) {
      send(res, 409, { error: 'Use os fluxos de publicação ou venda para alterar este status.' })
      return true
    }
    const result = db.prepare(`UPDATE vehicles SET year=?,make=?,model=?,trim=?,price=?,km=?,vehicle_type=?,location=?,transmission=?,fuel_type=?,body_type=?,exterior_color=?,interior_color=?,vehicle_condition=?,description=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
      .run(Number(vehicleInput.year), String(vehicleInput.make), String(vehicleInput.model).trim(), String(vehicleInput.trim || ''), Number(vehicleInput.price), Number(vehicleInput.km), String(vehicleInput.vehicleType), String(vehicleInput.location).trim(), String(vehicleInput.transmission), String(vehicleInput.fuelType), String(vehicleInput.bodyType), String(vehicleInput.exteriorColor), String(vehicleInput.interiorColor), String(vehicleInput.condition), String(vehicleInput.description).trim(), requestedStatus, vehicleId, auth.organizationId)
    send(res, result.changes ? 200 : 404, result.changes ? { ok: true } : { error: 'Veículo não encontrado.' })
    return true
  }

  const markSoldRoute = url.pathname.match(/^\/api\/vehicles\/(\d+)\/mark-sold$/)
  if (req.method === 'POST' && markSoldRoute) {
    const vehicleId = Number(markSoldRoute[1])
    if (!canWriteVehicle(vehicleId, auth)) {
      send(res, 403, { error: 'Você não pode alterar este veículo.' })
      return true
    }
    let canceledJobs = 0, reviewJobs = 0
    db.exec('BEGIN')
    try {
      db.prepare("UPDATE vehicles SET status='Vendido',sold_at=COALESCE(sold_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(vehicleId, auth.organizationId)
      const jobs = db.prepare(`SELECT id,status,fill_report fillReport FROM publication_jobs
        WHERE vehicle_id=? AND organization_id=? AND status IN ('pending','error','filling','awaiting_confirmation')`).all(vehicleId, auth.organizationId) as Array<{ id: number; status: string; fillReport: string }>
      for (const job of jobs) {
        let report: Record<string, unknown> = {}
        try {
          report = JSON.parse(job.fillReport || '{}')
        } catch {
          // Older reports may contain invalid JSON.
        }
        if (report.saleInterrupted === true) continue
        const needsReview = job.status === 'filling' || job.status === 'awaiting_confirmation' || report.publishAttempted === true
        db.prepare(`UPDATE publication_jobs SET status=?,paused=1,extension_visible=0,fill_report=?,
          lease_token=CASE WHEN ? THEN lease_token ELSE NULL END,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND organization_id=?`).run(needsReview ? 'awaiting_confirmation' : 'canceled', JSON.stringify({ ...report, saleInterrupted: true }), needsReview ? 1 : 0, job.id, auth.organizationId)
        recordJobEvent(auth.organizationId, job.id, needsReview ? 'sale_interrupted' : 'canceled', auth.userId, { reason: 'vehicle_sold', requiresReview: needsReview })
        if (needsReview) reviewJobs++
        else canceledJobs++
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    send(res, 200, { ok: true, canceledJobs, reviewJobs })
    return true
  }

  const vehicleImagesRoute = url.pathname.match(/^\/api\/vehicles\/(\d+)\/images$/)
  if (req.method === 'GET' && vehicleImagesRoute) {
    const images = db.prepare(`SELECT id,original_name originalName,mime_type mimeType,position,?||file_name url FROM vehicle_images WHERE vehicle_id=? AND organization_id=? ORDER BY position,id`)
      .all(imageBaseUrl, Number(vehicleImagesRoute[1]), auth.organizationId)
    send(res, 200, { images })
    return true
  }
  if (req.method === 'POST' && vehicleImagesRoute) {
    const vehicleId = Number(vehicleImagesRoute[1])
    if (!canWriteVehicle(vehicleId, auth)) {
      send(res, 403, { error: 'Você não pode alterar as fotos deste veículo.' })
      return true
    }
    const imageCount = (db.prepare('SELECT COUNT(*) total FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').get(vehicleId, auth.organizationId) as { total: number }).total
    if (imageCount >= 20) {
      send(res, 409, { error: 'Este veículo já possui o limite de 20 fotos.' })
      return true
    }
    const body = await jsonBody(req, IMAGE_UPLOAD_BODY_LIMIT) as Record<string, unknown>
    const mime = String(body.mimeType || '')
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      send(res, 400, { error: 'Use imagens JPG, PNG ou WebP.' })
      return true
    }
    const encoded = String(body.dataBase64 || '').trim()
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      send(res, 400, { error: 'Os dados da imagem estão em formato inválido.' })
      return true
    }
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded) {
      send(res, 400, { error: 'Os dados da imagem estão em formato inválido.' })
      return true
    }
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) {
      send(res, 400, { error: 'A imagem deve ter no máximo 12 MB.' })
      return true
    }
    if (!await validImageContent(bytes, mime)) {
      send(res, 400, { error: 'O arquivo não é uma imagem válida, completa e compatível com o formato informado.' })
      return true
    }
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const duplicate = db.prepare('SELECT id,file_name fileName FROM vehicle_images WHERE vehicle_id=? AND organization_id=? AND content_hash=?').get(vehicleId, auth.organizationId, contentHash) as { id: number; fileName: string } | undefined
    if (duplicate) {
      send(res, 200, { id: duplicate.id, url: `${imageBaseUrl}${duplicate.fileName}`, duplicate: true })
      return true
    }
    const confirmedCount = (db.prepare('SELECT COUNT(*) total FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').get(vehicleId, auth.organizationId) as { total: number }).total
    if (confirmedCount >= 20) {
      send(res, 409, { error: 'Este veículo já possui o limite de 20 fotos.' })
      return true
    }
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
    const fileName = `${randomBytes(12).toString('hex')}.${ext}`
    const filePath = join(uploadsDir, fileName)
    writeFileSync(filePath, bytes)
    try {
      const position = (db.prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM vehicle_images WHERE vehicle_id=?').get(vehicleId) as { next: number }).next
      const originalName = String(body.name || fileName).slice(0, 200)
      const result = db.prepare('INSERT INTO vehicle_images (organization_id,vehicle_id,file_name,original_name,mime_type,position,content_hash) VALUES (?,?,?,?,?,?,?)').run(auth.organizationId, vehicleId, fileName, originalName, mime, position, contentHash)
      send(res, 201, { id: Number(result.lastInsertRowid), url: `${imageBaseUrl}${fileName}` })
    } catch (error) {
      if (existsSync(filePath)) unlinkSync(filePath)
      throw error
    }
    return true
  }

  const imageReorderRoute = url.pathname.match(/^\/api\/vehicles\/(\d+)\/images\/reorder$/)
  if (req.method === 'PATCH' && imageReorderRoute) {
    const vehicleId = Number(imageReorderRoute[1])
    if (!canWriteVehicle(vehicleId, auth)) {
      send(res, 403, { error: 'Você não pode alterar as fotos deste veículo.' })
      return true
    }
    const body = await jsonBody(req) as { order?: unknown[] }
    const order = Array.isArray(body.order) ? body.order.map(Number).filter(Number.isInteger) : []
    const owned = db.prepare('SELECT id FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').all(vehicleId, auth.organizationId) as Array<{ id: number }>
    const ownedIds = new Set(owned.map(item => item.id))
    if (order.length !== owned.length || new Set(order).size !== order.length || !order.every(id => ownedIds.has(id))) {
      send(res, 400, { error: 'Lista de fotos inválida.' })
      return true
    }
    db.exec('BEGIN')
    try {
      order.forEach((id, index) => {
        db.prepare('UPDATE vehicle_images SET position=? WHERE id=? AND vehicle_id=? AND organization_id=?').run(index, id, vehicleId, auth.organizationId)
      })
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    send(res, 200, { ok: true })
    return true
  }

  const imageRoute = url.pathname.match(/^\/api\/vehicle-images\/(\d+)$/)
  if (req.method === 'DELETE' && imageRoute) {
    const imageId = Number(imageRoute[1])
    if (!canWriteImage(imageId, auth)) {
      send(res, 403, { error: 'Você não pode excluir esta imagem.' })
      return true
    }
    const image = db.prepare('SELECT file_name fileName FROM vehicle_images WHERE id=? AND organization_id=?').get(imageId, auth.organizationId) as { fileName: string } | undefined
    if (!image) {
      send(res, 404, { error: 'Imagem não encontrada.' })
      return true
    }
    const path = join(uploadsDir, image.fileName)
    if (existsSync(path)) unlinkSync(path)
    db.prepare('DELETE FROM vehicle_images WHERE id=? AND organization_id=?').run(imageId, auth.organizationId)
    send(res, 200, { ok: true })
    return true
  }

  if (req.method === 'DELETE' && url.pathname === '/api/vehicles') {
    if (!isAdmin(auth)) {
      send(res, 403, { error: 'Somente administradores podem excluir veículos.' })
      return true
    }
    const body = await jsonBody(req) as { ids?: unknown[] }
    const ids = [...new Set((body.ids || []).map(Number).filter(Number.isInteger))].slice(0, 100)
    if (!ids.length) {
      send(res, 400, { error: 'Selecione pelo menos um veículo.' })
      return true
    }
    const placeholders = ids.map(() => '?').join(',')
    const owned = db.prepare(`SELECT id FROM vehicles WHERE organization_id=? AND id IN (${placeholders})`).all(auth.organizationId, ...ids) as Array<{ id: number }>
    if (!owned.length) {
      send(res, 404, { error: 'Nenhum dos veículos selecionados foi encontrado.' })
      return true
    }
    const protectedJobs = db.prepare(`SELECT j.id jobId,j.vehicle_id vehicleId,j.status,v.year,v.make,v.model
      FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id
      WHERE j.organization_id=? AND j.vehicle_id IN (${placeholders})
        AND j.status IN ('pending','filling','error','awaiting_confirmation','completed')
      ORDER BY j.vehicle_id,j.id`).all(auth.organizationId, ...ids) as Array<{ jobId: number; vehicleId: number; status: string; year: number; make: string; model: string }>
    if (protectedJobs.length) {
      send(res, 409, {
        error: 'Não é possível excluir veículos com anúncios ou execuções pendentes. Encerre ou marque os trabalhos relacionados antes de excluir.',
        vehicles: protectedJobs.map(job => ({ vehicleId: job.vehicleId, jobId: job.jobId, status: job.status, label: `${job.year} ${job.make} ${job.model}` })),
      })
      return true
    }
    const filesToDelete: string[] = []
    let removedJobs = 0
    db.exec('BEGIN')
    try {
      for (const item of owned) {
        const images = db.prepare('SELECT file_name fileName FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').all(item.id, auth.organizationId) as Array<{ fileName: string }>
        filesToDelete.push(...images.map(image => join(uploadsDir, image.fileName)))
        const jobIds = db.prepare('SELECT id FROM publication_jobs WHERE vehicle_id=? AND organization_id=?').all(item.id, auth.organizationId) as Array<{ id: number }>
        if (jobIds.length) {
          const jobPlaceholders = jobIds.map(() => '?').join(',')
          db.prepare(`DELETE FROM publication_job_events WHERE organization_id=? AND publication_job_id IN (${jobPlaceholders})`).run(auth.organizationId, ...jobIds.map(job => job.id))
        }
        removedJobs += Number(db.prepare('DELETE FROM publication_jobs WHERE vehicle_id=? AND organization_id=?').run(item.id, auth.organizationId).changes)
        db.prepare('DELETE FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').run(item.id, auth.organizationId)
        db.prepare('DELETE FROM vehicles WHERE id=? AND organization_id=?').run(item.id, auth.organizationId)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    for (const path of filesToDelete) {
      try {
        if (existsSync(path)) unlinkSync(path)
      } catch (error) {
        console.warn(`Não foi possível remover o arquivo órfão ${path}:`, error)
      }
    }
    send(res, 200, { deleted: owned.length, removedJobs })
    return true
  }
  return false
}
