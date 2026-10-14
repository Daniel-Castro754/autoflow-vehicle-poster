import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const PHOTO_CATEGORIES = [
  'front',
  'side',
  'rear',
  'interior',
  'dashboard',
  'engine',
  'detail',
  'other',
] as const
export type PhotoCategory = (typeof PHOTO_CATEGORIES)[number]
export const PREFERRED_PHOTO_COUNT = 8

type PhotoRow = {
  id: number
  fileName: string
  originalName: string
  mimeType: string
  position: number
  contentHash: string
  category: PhotoCategory
}
type PhotoSelection = { photoIds: string; inventoryFingerprint: string }
export class PhotoCurationConflict extends Error {}

function inventory(db: DatabaseSync, org: number, vehicleId: number): PhotoRow[] {
  return db
    .prepare(
      'SELECT id,file_name fileName,original_name originalName,mime_type mimeType,' +
        ' position,content_hash contentHash,photo_category category FROM vehicle_images' +
        ' WHERE organization_id=? AND vehicle_id=? ORDER BY position,id',
    )
    .all(org, vehicleId) as PhotoRow[]
}

function selection(db: DatabaseSync, org: number, vehicleId: number) {
  return db
    .prepare(
      'SELECT photo_ids photoIds,inventory_fingerprint inventoryFingerprint ' +
        'FROM vehicle_photo_selections WHERE organization_id=? AND vehicle_id=?',
    )
    .get(org, vehicleId) as PhotoSelection | undefined
}

export function photoInventoryFingerprint(photos: PhotoRow[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        photos.map(({ id, contentHash, position, category }) => [
          id,
          contentHash,
          position,
          category,
        ]),
      ),
    )
    .digest('hex')
}

function parseIds(raw: string): number[] {
  try {
    const ids: unknown = JSON.parse(raw)
    if (
      Array.isArray(ids) &&
      ids.length > 0 &&
      ids.length <= 20 &&
      ids.every((id) => Number.isSafeInteger(id) && id > 0) &&
      new Set(ids).size === ids.length
    )
      return ids
  } catch {
    // Invalid persisted selections must fail closed instead of uploading all photos.
  }
  throw new PhotoCurationConflict(
    'Seleção de fotos inválida. Revise a curadoria antes de publicar.',
  )
}

export function recommendPhotos(
  photos: PhotoRow[],
  preferredCount = PREFERRED_PHOTO_COUNT,
): number[] {
  const limit = Math.max(1, Math.min(20, Math.floor(preferredCount)))
  if (!photos.length) return []
  const front = photos.find((photo) => photo.category === 'front')
  const cover = front || photos[0]!
  const chosen = [cover.id]
  const remaining = photos.filter((photo) => photo.id !== cover.id)
  const groups = PHOTO_CATEGORIES.map((category) =>
    remaining.filter((photo) => photo.category === category).map((photo) => photo.id),
  )
  while (chosen.length < Math.min(limit, photos.length)) {
    let advanced = false
    for (const group of groups) {
      if (chosen.length >= limit) break
      const next = group.shift()
      if (next !== undefined) {
        chosen.push(next)
        advanced = true
      }
    }
    if (!advanced) break
  }
  return chosen
}

export function readPhotoCuration(
  db: DatabaseSync,
  org: number,
  vehicleId: number,
  imageBaseUrl: string,
) {
  const photos = inventory(db, org, vehicleId)
  const saved = selection(db, org, vehicleId)
  const fingerprint = photoInventoryFingerprint(photos)
  const outdated = Boolean(saved && saved.inventoryFingerprint !== fingerprint)
  const automatic = Boolean(photos.length && (!saved || outdated))
  let selectedIds = automatic ? recommendPhotos(photos) : []
  let invalid = false
  if (saved && !outdated) {
    try {
      selectedIds = parseIds(saved.photoIds)
      const owned = new Set(photos.map((photo) => photo.id))
      if (selectedIds.some((id) => !owned.has(id))) invalid = true
    } catch {
      // Persisted invalid selections are not silently accepted as approved.
      invalid = true
    }
  }
  const approved = Boolean(saved && !outdated && !invalid)
  return {
    images: photos.map(({ id, originalName, mimeType, position, category, fileName }) => ({
      id,
      originalName,
      mimeType,
      position,
      category,
      url: imageBaseUrl + fileName,
    })),
    preferredCount: PREFERRED_PHOTO_COUNT,
    recommendation: recommendPhotos(photos),
    fingerprint,
    enabled: Boolean(saved),
    approved,
    automatic,
    selectionOutdated: outdated,
    needsReview: invalid,
    selectedIds,
  }
}

export function assertPhotoCurationEditable(db: DatabaseSync, org: number, vehicleId: number) {
  const vehicle = db
    .prepare('SELECT status,sold_at soldAt FROM vehicles WHERE organization_id=? AND id=?')
    .get(org, vehicleId) as { status: string; soldAt: string | null } | undefined
  if (!vehicle) throw new PhotoCurationConflict('Veículo não encontrado.')
  if (vehicle.soldAt || ['Publicado', 'Vendido'].includes(vehicle.status))
    throw new PhotoCurationConflict(
      'As fotos de um veículo publicado ou vendido não podem ser alteradas.',
    )
  const active = db
    .prepare(
      'SELECT id FROM publication_jobs WHERE organization_id=? AND vehicle_id=? ' +
        "AND status IN ('pending','filling','error','awaiting_confirmation','completed') LIMIT 1",
    )
    .get(org, vehicleId)
  if (active)
    throw new PhotoCurationConflict(
      'Este veículo já tem um trabalho ativo ou anúncio publicado. Resolva-o antes de alterar as fotos.',
    )
}

export function setPhotoCategory(
  db: DatabaseSync,
  org: number,
  vehicleId: number,
  imageId: number,
  category: PhotoCategory,
) {
  if (!PHOTO_CATEGORIES.includes(category)) throw new Error('Categoria de fotografia inválida.')
  db.exec('BEGIN IMMEDIATE')
  try {
    assertPhotoCurationEditable(db, org, vehicleId)
    const changed = db
      .prepare(
        'UPDATE vehicle_images SET photo_category=? WHERE id=? AND organization_id=? AND vehicle_id=?',
      )
      .run(category, imageId, org, vehicleId)
    if (!changed.changes)
      throw new PhotoCurationConflict('Fotografia não encontrada neste veículo.')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function approvePhotoSelection(
  db: DatabaseSync,
  org: number,
  vehicleId: number,
  rawIds: unknown,
  expectedFingerprint: unknown,
) {
  if (
    !Array.isArray(rawIds) ||
    rawIds.length < 1 ||
    rawIds.length > 20 ||
    rawIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(rawIds).size !== rawIds.length ||
    typeof expectedFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expectedFingerprint)
  )
    throw new Error('Selecione de 1 a 20 fotografias reais e confirme a prévia atual.')
  db.exec('BEGIN IMMEDIATE')
  try {
    assertPhotoCurationEditable(db, org, vehicleId)
    const photos = inventory(db, org, vehicleId)
    const fingerprint = photoInventoryFingerprint(photos)
    if (fingerprint !== expectedFingerprint)
      throw new PhotoCurationConflict('As fotografias mudaram desde a prévia. Revise novamente.')
    const allIds = new Set(photos.map((photo) => photo.id))
    if (!rawIds.every((id) => allIds.has(id)))
      throw new Error('A seleção contém fotos de outro veículo ou não disponíveis.')
    db.prepare(
      'INSERT INTO vehicle_photo_selections ' +
        '(organization_id,vehicle_id,photo_ids,inventory_fingerprint,approved_at) ' +
        'VALUES (?,?,?,?,CURRENT_TIMESTAMP) ' +
        'ON CONFLICT (organization_id,vehicle_id) DO UPDATE SET ' +
        'photo_ids=excluded.photo_ids,inventory_fingerprint=excluded.inventory_fingerprint,' +
        'approved_at=CURRENT_TIMESTAMP',
    ).run(org, vehicleId, JSON.stringify(rawIds), fingerprint)
    db.exec('COMMIT')
    return { ok: true, selectedCount: rawIds.length }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function disablePhotoSelection(db: DatabaseSync, org: number, vehicleId: number) {
  db.exec('BEGIN IMMEDIATE')
  try {
    assertPhotoCurationEditable(db, org, vehicleId)
    db.prepare('DELETE FROM vehicle_photo_selections WHERE organization_id=? AND vehicle_id=?').run(
      org,
      vehicleId,
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function photoIdsForInventory(photos: PhotoRow[], saved: PhotoSelection | undefined) {
  if (!photos.length)
    throw new PhotoCurationConflict(
      'Este veículo ainda não possui fotos. Importe fotos reais antes de publicar.',
    )
  const fingerprint = photoInventoryFingerprint(photos)
  // Preserve current manual covers/orders. New or outdated selections fall
  // back to real inventory photos; invalid current selections fail closed.
  const ids =
    saved && saved.inventoryFingerprint === fingerprint
      ? parseIds(saved.photoIds)
      : recommendPhotos(photos)
  const owned = new Set(photos.map((photo) => photo.id))
  if (ids.some((id) => !owned.has(id)))
    throw new PhotoCurationConflict('Seleção de fotografias inconsistente.')
  return ids
}

// Used by the signed photo route as well as the publication payload.
// Both endpoints must agree on exactly the same authorized photo set.
export function selectedPublicationPhotoIds(db: DatabaseSync, org: number, vehicleId: number) {
  return photoIdsForInventory(inventory(db, org, vehicleId), selection(db, org, vehicleId))
}

export function publicationPhotoPayload(
  db: DatabaseSync,
  org: number,
  vehicleId: number,
  baseUrl: string,
) {
  const photos = inventory(db, org, vehicleId)
  const ids = photoIdsForInventory(photos, selection(db, org, vehicleId))
  const byId = new Map(photos.map((photo) => [photo.id, photo]))
  const ordered = ids.map((id) => byId.get(id)!)
  return ordered.map((photo) => ({
    url: baseUrl + photo.fileName,
    name: photo.originalName,
    mimeType: photo.mimeType,
  }))
}
