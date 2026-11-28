import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validImageContent } from '../services/vehicle-input.ts'
import { normalizeInventoryIdentifier, validateInventoryIdentifiers } from '../services/vehicle-import.ts'
import { integrationHasScope, readIntegrationAuth, type IntegrationAuth } from '../services/integration-auth.ts'

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
  const auditDenied = (reason: string) => {
    db.prepare(
      `INSERT INTO integration_audit_events
       (organization_id,credential_id,actor_user_id,action,outcome,details)
       VALUES (?,?,?,'photos:write','denied',?)`,
    ).run(auth.organizationId, auth.credentialId, auth.createdBy, JSON.stringify({ reason }))
  }
  if (!integrationHasScope(auth, 'photos:write')) {
    auditDenied('missing_scope')
    send(res, 403, { error: 'Escopo photos:write obrigatório.' })
    return true
  }
  const vehicleId = Number(match[1])
  const vehicle = db
    .prepare('SELECT status FROM vehicles WHERE id=? AND organization_id=?')
    .get(vehicleId, auth.organizationId) as { status: string } | undefined
  if (!vehicle) {
    auditDenied('vehicle_not_found')
    send(res, 404, { error: 'Veículo não encontrado.' })
    return true
  }
  if (vehicle.status !== 'Rascunho') {
    auditDenied('vehicle_not_draft')
    send(res, 409, { error: 'Envio pela integração permitido somente em rascunhos.' })
    return true
  }
  const input = await jsonBody(req, 17 * 1024 * 1024)
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    auditDenied('invalid_body')
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
    auditDenied('invalid_encoding')
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
    auditDenied('invalid_image')
    send(res, 400, { error: 'Imagem inválida, incompleta ou maior que 12 MB.' })
    return true
  }
  const hash = createHash('sha256').update(bytes).digest('hex')
  const expectedStock = body.stockCode === undefined ? null : typeof body.stockCode === 'string' &&
    body.stockCode.toUpperCase().replace(/\s+/g,'').length <= 64 ? normalizeInventoryIdentifier(body.stockCode) : ''
  if ((expectedStock !== null && (!expectedStock || validateInventoryIdentifiers(expectedStock,''))) ||
      (body.sha256 !== undefined && (typeof body.sha256 !== 'string' || body.sha256.toLowerCase() !== hash))) {
    auditDenied('identity_or_hash_invalid')
    send(res, 400, { error: 'Código de estoque ou hash de conteúdo inválido.' })
    return true
  }
  let filePath: string | null = null
  db.exec('BEGIN IMMEDIATE')
  let response: { status: number; data: unknown }
  try {
    response = (() => {
      const deny = (status: number, reason: string, error: string) => {
        auditDenied(reason)
        return {status,data:{error}}
      }
      const currentAuth=readIntegrationAuth(db,req)
      if (!currentAuth || currentAuth.credentialId!==auth.credentialId || currentAuth.organizationId!==auth.organizationId)
        return deny(401,'credential_changed','Credencial de integração inválida, expirada ou revogada.')
      if (!integrationHasScope(currentAuth,'photos:write'))
        return deny(403,'missing_scope','Escopo photos:write obrigatório.')
      const current=db.prepare(`SELECT v.status,v.stock_code stockCode,v.sold_at soldAt,
        EXISTS(SELECT 1 FROM publication_jobs j WHERE j.organization_id=v.organization_id AND j.vehicle_id=v.id
          AND j.status IN ('pending','filling','error','awaiting_confirmation','completed')) protectedWork
        FROM vehicles v WHERE v.organization_id=? AND v.id=?`).get(auth.organizationId,vehicleId)
      if(!current)return deny(404,'vehicle_not_found','Veículo não encontrado.')
      if(current.status!=='Rascunho'||current.soldAt||current.protectedWork)
        return deny(409,'vehicle_protected','Envio permitido somente em rascunhos sem trabalho protegido.')
      if(expectedStock!==null&&normalizeInventoryIdentifier(current.stockCode)!==expectedStock)
        return deny(409,'stock_changed','Código de estoque não corresponde ao veículo.')
      const shared=db.prepare('SELECT 1 FROM vehicle_images WHERE organization_id=? AND vehicle_id<>? AND content_hash=? LIMIT 1').get(auth.organizationId,vehicleId,hash)
      if(shared)return deny(409,'shared_photo','Foto já associada a outro veículo. Revise a identidade.')
      const duplicate=db.prepare('SELECT id FROM vehicle_images WHERE vehicle_id=? AND organization_id=? AND content_hash=?').get(vehicleId,auth.organizationId,hash)
      if(duplicate)return {status:200,data:{id:duplicate.id,duplicate:true,requiresReview:true}}
      const count=db.prepare('SELECT COUNT(*) total FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').get(vehicleId,auth.organizationId)
      if(Number(count?.total)>=20)return deny(409,'photo_limit','Limite de 20 fotos por veículo.')
      const ext=mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg'
      const fileName=randomBytes(12).toString('hex')+'.'+ext
      const path=join(uploadsDir,fileName)
      if(existsSync(path))throw new Error('Colisão no nome de arquivo.')
      filePath=path
      writeFileSync(path,bytes,{flag:'wx'})
      const position=db.prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').get(vehicleId,auth.organizationId)
      const originalName=typeof body.name==='string'?body.name.slice(0,200):fileName
      const created=db.prepare('INSERT INTO vehicle_images (organization_id,vehicle_id,file_name,original_name,mime_type,position,content_hash) VALUES (?,?,?,?,?,?,?)')
        .run(auth.organizationId,vehicleId,fileName,originalName,mime,Number(position?.next),hash)
      db.prepare(`INSERT INTO integration_audit_events
        (organization_id,credential_id,actor_user_id,action,resource_type,resource_id,outcome)
        VALUES (?,?,?,'photos:write','vehicle',?,'allowed')`).run(auth.organizationId,auth.credentialId,auth.createdBy,vehicleId)
      return {status:201,data:{id:Number(created.lastInsertRowid),vehicleId,requiresReview:true}}
    })()
    db.exec('COMMIT')
  } catch(error) {
    db.exec('ROLLBACK')
    if(filePath&&existsSync(filePath))unlinkSync(filePath)
    throw error
  }
  send(res,response.status,response.data)
  return true
}
