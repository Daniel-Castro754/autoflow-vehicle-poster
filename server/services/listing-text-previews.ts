import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { generateListingTextVariants, type ListingTextVariant } from './listing-generator.ts'
import type { VehicleInput } from './description-generator.ts'

type SavedVehicle = VehicleInput & {
  id: number
  status: string
  soldAt: string | null
  description: string
  updatedAt: string
}

type StoredPreview = {
  vehicleId: number
  fingerprint: string
  variants: ListingTextVariant[]
}

const selectVehicle =
  'SELECT id,year,make,model,trim,price,km,transmission,' +
  'fuel_type fuelType,body_type bodyType,exterior_color exteriorColor,' +
  'interior_color interiorColor,vehicle_condition condition,location,' +
  'status,sold_at soldAt,description,updated_at updatedAt ' +
  'FROM vehicles WHERE organization_id=? AND id=?'

function readVehicle(db: DatabaseSync, org: number, vehicleId: number) {
  return db.prepare(selectVehicle).get(org, vehicleId) as SavedVehicle | undefined
}

function fingerprint(vehicle: SavedVehicle) {
  return createHash('sha256').update(JSON.stringify(vehicle)).digest('hex')
}

function assertEditable(db: DatabaseSync, org: number, vehicle: SavedVehicle | undefined) {
  if (!vehicle || vehicle.soldAt || !['Rascunho', 'Pronto'].includes(vehicle.status))
    throw new Error(
      'Somente veículos disponíveis e ainda não publicados podem receber novas descrições.',
    )
  const existing = db
    .prepare(
      'SELECT 1 FROM publication_jobs WHERE organization_id=? AND vehicle_id=? ' +
        "AND status IN ('pending','filling','error','awaiting_confirmation','completed') LIMIT 1",
    )
    .get(org, vehicle.id)
  if (existing)
    throw new Error(
      'Este veículo já possui publicação ativa ou concluída. Resolva a publicação anterior.',
    )
}

export function prepareListingTextPreview(
  db: DatabaseSync,
  organizationId: number,
  userId: number,
  vehicleId: number,
) {
  if (!Number.isSafeInteger(vehicleId) || vehicleId <= 0)
    throw new Error('Identificador do veículo inválido.')
  const vehicle = readVehicle(db, organizationId, vehicleId)
  assertEditable(db, organizationId, vehicle)
  const variants = generateListingTextVariants(vehicle!)
  const id = randomUUID()
  const preview: StoredPreview = { vehicleId, fingerprint: fingerprint(vehicle!), variants }
  db.prepare(
    'INSERT INTO listing_text_previews (id,organization_id,user_id,vehicle_id,payload,expires_at) ' +
      "VALUES (?,?,?,?,?,datetime('now','+15 minutes'))",
  ).run(id, organizationId, userId, vehicleId, JSON.stringify(preview))
  return {
    ok: true,
    previewId: id,
    expiresInMinutes: 15,
    style: 'balanced' as const,
    requiresApproval: true,
    variants,
  }
}

export function approveListingTextPreview(
  db: DatabaseSync,
  organizationId: number,
  userId: number,
  previewId: string,
  variantId: number,
) {
  if (!/^[0-9a-f-]{36}$/i.test(previewId)) throw new Error('Identificador da prévia inválido.')
  if (!Number.isInteger(variantId) || variantId < 1 || variantId > 3)
    throw new Error('Escolha uma das versões apresentadas.')
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db
      .prepare(
        'SELECT payload FROM listing_text_previews ' +
          'WHERE id=? AND organization_id=? AND user_id=? AND consumed_at IS NULL ' +
          'AND datetime(expires_at)>CURRENT_TIMESTAMP',
      )
      .get(previewId, organizationId, userId) as { payload: string } | undefined
    if (!row) throw new Error('Prévia expirada, já aprovada ou de outro usuário. Gere outra.')
    const preview = JSON.parse(row.payload) as StoredPreview
    const chosen = preview.variants.find((variant) => variant.id === variantId)
    if (!chosen || !chosen.description.trim())
      throw new Error('Versão não disponível nesta prévia.')
    const current = readVehicle(db, organizationId, preview.vehicleId)
    assertEditable(db, organizationId, current)
    if (fingerprint(current!) !== preview.fingerprint)
      throw new Error('O veículo foi modificado após a prévia. Gere novas opções.')
    // The original title remains derived from structured vehicle fields in the extension.
    db.prepare(
      'UPDATE vehicles SET description=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?',
    ).run(chosen.description, preview.vehicleId, organizationId)
    const used = db
      .prepare(
        'UPDATE listing_text_previews SET consumed_at=CURRENT_TIMESTAMP ' +
          'WHERE id=? AND organization_id=? AND user_id=? AND consumed_at IS NULL',
      )
      .run(previewId, organizationId, userId)
    if (used.changes !== 1) throw new Error('Prévia já utilizada.')
    db.exec('COMMIT')
    return { ok: true, vehicleId: preview.vehicleId, approvedVariantId: variantId }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
