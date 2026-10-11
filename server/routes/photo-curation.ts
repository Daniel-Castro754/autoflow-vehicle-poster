import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import {
  approvePhotoSelection,
  disablePhotoSelection,
  PHOTO_CATEGORIES,
  PhotoCurationConflict,
  readPhotoCuration,
  setPhotoCategory,
  type PhotoCategory,
} from '../services/photo-curation.ts'

type Auth = { userId: number; organizationId: number }
type Dependencies = {
  db: DatabaseSync
  send: (response: ServerResponse, status: number, data: unknown) => void
  jsonBody: (req: IncomingMessage) => Promise<unknown>
  imageBaseUrl: string
  canWriteVehicle: (vehicleId: number, auth: Auth) => boolean
}

export async function handlePhotoCurationRoute(
  req: IncomingMessage, res: ServerResponse, url: URL, auth: Auth, deps: Dependencies,
): Promise<boolean> {
  const collection = url.pathname.match(/^\/api\/vehicles\/(\d+)\/photos\/(curation|selection)$/)
  const categoryRoute = url.pathname.match(/^\/api\/vehicles\/(\d+)\/photos\/(\d+)\/category$/)
  if (!collection && !categoryRoute) return false
  const vehicleId = Number((collection || categoryRoute)![1])
  if (!Number.isSafeInteger(vehicleId) || vehicleId <= 0) {
    deps.send(res, 400, { error: 'Veículo inválido.' })
    return true
  }
  const vehicle = deps.db.prepare(
    'SELECT id FROM vehicles WHERE id=? AND organization_id=?',
  ).get(vehicleId, auth.organizationId)
  if (!vehicle) {
    deps.send(res, 404, { error: 'Veículo não encontrado.' })
    return true
  }
  if (req.method === 'GET' && collection?.[2] === 'curation') {
    deps.send(res, 200, readPhotoCuration(deps.db, auth.organizationId, vehicleId, deps.imageBaseUrl))
    return true
  }
  if (!deps.canWriteVehicle(vehicleId, auth)) {
    deps.send(res, 403, { error: 'Você não pode editar as fotos deste veículo.' })
    return true
  }
  try {
    if (req.method === 'PATCH' && categoryRoute) {
      const body = (await deps.jsonBody(req)) as Record<string, unknown>
      const imageId = Number(categoryRoute[2])
      if (!Number.isSafeInteger(imageId) || !PHOTO_CATEGORIES.includes(body?.category as PhotoCategory)) {
        deps.send(res, 400, { error: 'Foto ou categoria inválida.' })
        return true
      }
      setPhotoCategory(deps.db, auth.organizationId, vehicleId, imageId, body.category as PhotoCategory)
      deps.send(res, 200, { ok: true })
      return true
    }
    if (req.method === 'POST' && collection?.[2] === 'selection') {
      const body = (await deps.jsonBody(req)) as Record<string, unknown>
      const result = approvePhotoSelection(
        deps.db, auth.organizationId, vehicleId, body?.photoIds, body?.fingerprint,
      )
      deps.send(res, 200, result)
      return true
    }
    if (req.method === 'DELETE' && collection?.[2] === 'selection') {
      disablePhotoSelection(deps.db, auth.organizationId, vehicleId)
      deps.send(res, 200, { ok: true })
      return true
    }
  } catch (error) {
    deps.send(res, error instanceof PhotoCurationConflict ? 409 : 400, {
      error: error instanceof Error ? error.message : 'Não foi possível atualizar as fotos.',
    })
    return true
  }
  deps.send(res, 405, { error: 'Método não permitido.' })
  return true
}
