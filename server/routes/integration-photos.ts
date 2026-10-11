import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validImageContent } from '../services/vehicle-input.ts'
import {
  integrationHasScope,
  type IntegrationAuth,
} from '../services/integration-auth.ts'

type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  jsonBody: (req: IncomingMessage, maxBytes?: number) => Promise<unknown>
  uploadsDir: string
}

export async function handleIntegrationPhotoUpload(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: IntegrationAuth,
  { db, send, jsonBody, uploadsDir }: Dependencies,
): Promise<boolean> {
  const match = /^\/api\/integration\/v1\/vehicles\/(\d+)\/photos$/.exec(url.pathname)
  if (!match) return false
  if (req.method !== 'POST') {
    send(res, 405, { error: 'Método não permitido.' })
    return true
  }
  if (!integrationHasScope(auth, 'photos:write')) {
    send(res, 403, { error: 'Escopo photos:write obrigatório.' })
    return true
  }
  const vehicleId = Number(match[1])
  const vehicle = db
    .prepare('SELECT status FROM vehicles WHERE id=? AND organization_id=?')
    .get(vehicleId, auth.organizationId) as { status: string } | undefined
  if (!vehicle) {
    send(res, 404, { error: 'Veículo não encontrado.' })
    return true
  }
  if (vehicle.status !== 'Rascunho') {
    send(res, 409, { error: 'Envio pela integração permitido somente em rascunhos.' })
    return true
  }
  const input = await jsonBody(req, 17 * 1024 * 1024)
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    send(res, 400, { error: 'Dados da foto inválidos.' })
    return true
  }
  const body = input as Record<string, unknown>
  const mime = body.mimeType
  const encoded = body.dataBase64
  if (
    typeof mime !== 'string' ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(mime) ||
    typeof encoded !== 'string' ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    send(res, 400, { error: 'Envie uma imagem JPG, PNG ou WebP em base64 válido.' })
    return true
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (
    !bytes.length ||
    bytes.length > 12 * 1024 * 1024 ||
    bytes.toString('base64') !== encoded ||
    !(await validImageContent(bytes, mime))
  ) {
    send(res, 400, { error: 'Imagem inválida, incompleta ou maior que 12 MB.' })
    return true
  }
  const hash = createHash('sha256').update(bytes).digest('hex')
  const duplicate = db
    .prepare(
      'SELECT id FROM vehicle_images WHERE vehicle_id=? AND organization_id=? AND content_hash=?',
    )
    .get(vehicleId, auth.organizationId, hash) as { id: number } | undefined
  if (duplicate) {
    send(res, 200, { id: duplicate.id, duplicate: true, requiresReview: true })
    return true
  }
  const count = db
    .prepare('SELECT COUNT(*) total FROM vehicle_images WHERE vehicle_id=? AND organization_id=?')
    .get(vehicleId, auth.organizationId) as { total: number }
  if (count.total >= 20) {
    send(res, 409, { error: 'Limite de 20 fotos por veículo.' })
    return true
  }
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
  const fileName = randomBytes(12).toString('hex') + '.' + ext
  const filePath = join(uploadsDir, fileName)
  writeFileSync(filePath, bytes)
  try {
    const position = db
      .prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM vehicle_images WHERE vehicle_id=?')
      .get(vehicleId) as { next: number }
    const originalName =
      typeof body.name === 'string' ? body.name.slice(0, 200) : fileName
    const created = db
      .prepare(
        'INSERT INTO vehicle_images (organization_id,vehicle_id,file_name,original_name,mime_type,position,content_hash) VALUES (?,?,?,?,?,?,?)',
      )
      .run(auth.organizationId, vehicleId, fileName, originalName, mime, position.next, hash)
    const id = Number(created.lastInsertRowid)
    db.prepare(
      `INSERT INTO integration_audit_events
       (organization_id,credential_id,actor_user_id,action,resource_type,resource_id,outcome)
       VALUES (?,?,?,'photos:write','vehicle',?,'allowed')`,
    ).run(auth.organizationId, auth.credentialId, auth.createdBy, vehicleId)
    send(res, 201, { id, vehicleId, requiresReview: true })
  } catch (error) {
    if (existsSync(filePath)) unlinkSync(filePath)
    throw error
  }
  return true
}
