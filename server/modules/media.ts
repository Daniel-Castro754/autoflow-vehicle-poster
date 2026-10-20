import { timingSafeEqual } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { renderMildPhotoVariant, signedPublicationPhotoToken } from '../services/image-manager.ts'
import { selectedPublicationPhotoIds, PhotoCurationConflict } from '../services/photo-curation.ts'

export interface MediaModuleDependencies {
  db: DatabaseSync
  uploadsDir: string
  secret: string
  send: (res: ServerResponse, status: number, data: unknown) => void
}

// Public media routes are intentionally registered before authentication.
// Only tightly scoped filenames and HMAC-verified publication variants are served.
export async function handleMediaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  dependencies: MediaModuleDependencies,
): Promise<boolean> {
  const { db, uploadsDir, secret, send } = dependencies
  function respond(response: ServerResponse, status: number, data: unknown): true {
    send(response, status, data)
    return true
  }
  const imageVariant = url.pathname.match(
    /^\/uploads\/variants\/([1-9]\d*)\/([1-9]\d*)\/([a-f0-9]{64})\.jpg$/,
  )
  if (req.method === 'GET' && imageVariant) {
    const jobId = Number(imageVariant[1])
    const photoId = Number(imageVariant[2])
    if (!Number.isSafeInteger(jobId) || !Number.isSafeInteger(photoId))
      return respond(res, 404, { error: 'Fotografia inválida.' })
    const source = db
      .prepare(
        `SELECT i.organization_id organizationId,i.vehicle_id vehicleId,i.file_name fileName
        FROM publication_jobs job
        JOIN vehicle_images i ON i.organization_id=job.organization_id
          AND i.vehicle_id=job.vehicle_id
        WHERE job.id=? AND i.id=? AND job.status!='canceled'`,
      )
      .get(jobId, photoId) as
      { organizationId: number; vehicleId: number; fileName: string } | undefined
    if (!source) return respond(res, 404, { error: 'Fotografia não encontrada.' })
    const expected = signedPublicationPhotoToken(secret, source.organizationId, jobId, photoId)
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(imageVariant[3], 'hex')))
      return respond(res, 403, { error: 'Imagem não autorizada.' })
    let selected: number[]
    try {
      selected = selectedPublicationPhotoIds(db, source.organizationId, source.vehicleId)
    } catch (error) {
      if (error instanceof PhotoCurationConflict)
        return respond(res, 404, { error: 'Seleção de fotografias indisponível.' })
      throw error
    }
    if (!selected.includes(photoId))
      return respond(res, 404, { error: 'Fotografia fora da seleção de publicação.' })
    const original = await readFile(join(uploadsDir, source.fileName)).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!original) return respond(res, 404, { error: 'Arquivo da fotografia não encontrado.' })
    const rendered = await renderMildPhotoVariant(original, jobId, photoId)
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': rendered.length,
      'Cache-Control': 'private, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(rendered)
    return true
  }
  const uploadFile = url.pathname.match(/^\/uploads\/([a-f0-9]{24}\.(?:jpg|jpeg|png|webp))$/)
  if (req.method === 'GET' && uploadFile) {
    const path = join(uploadsDir, uploadFile[1])
    const file = await open(path, 'r').catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!file) return respond(res, 404, { error: 'Imagem não encontrada.' })
    try {
      const info = await file.stat()
      const ext = uploadFile[1].split('.').pop()
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': info.size,
        'Cache-Control': 'public, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
      })
      await pipeline(file.createReadStream({ autoClose: false }), res)
    } finally {
      await file.close()
    }
    return true
  }

  return false
}
