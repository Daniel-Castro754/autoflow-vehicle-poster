import type { DatabaseSync } from 'node:sqlite'
import { vehicleOptions } from './vehicle-input.ts'

const retryableExtensionFailureCodes = new Set(['marketplace_form_timeout'])

export function isRetryableExtensionFailureCode(value: unknown) {
  return typeof value === 'string' && retryableExtensionFailureCodes.has(value)
}

export function publicationReadinessIssues(
  vehicle: {
    year: number
    make: string
    model: string
    price: number
    km: number
    location: string
    description: string
    vehicleType: string
    transmission: string
    fuelType: string
    bodyType: string
    exteriorColor: string
    interiorColor: string
    condition: string
  },
  imageCount: number,
  requireDescription = true,
) {
  const missing: string[] = []
  if (!(vehicle.price > 0)) missing.push('Preço')
  if (!(vehicle.year >= 1900)) missing.push('Ano')
  if (!String(vehicle.make || '').trim()) missing.push('Fabricante')
  if (!String(vehicle.model || '').trim()) missing.push('Modelo')
  if (!(vehicle.km >= 0)) missing.push('Quilometragem')
  if (!vehicle.location.trim()) missing.push('Localização')
  if (!vehicleOptions.vehicleType.has(String(vehicle.vehicleType))) missing.push('Tipo de veículo')
  if (!vehicleOptions.transmission.has(String(vehicle.transmission))) missing.push('Câmbio')
  if (!vehicleOptions.fuelType.has(String(vehicle.fuelType))) missing.push('Combustível')
  if (!vehicleOptions.bodyType.has(String(vehicle.bodyType))) missing.push('Carroceria')
  if (!vehicleOptions.condition.has(String(vehicle.condition))) missing.push('Condição do veículo')
  if (!vehicleOptions.color.has(String(vehicle.exteriorColor))) missing.push('Cor externa')
  if (!vehicleOptions.color.has(String(vehicle.interiorColor))) missing.push('Cor interna')
  if (requireDescription && !vehicle.description.trim()) missing.push('Descrição')
  if (!imageCount) missing.push('Fotos')
  return missing
}

export function publicationDuplicateRisk(db: DatabaseSync, organizationId: number, vehicleId: number, excludeJobId = 0) {
  const sameVehicle = db.prepare(`SELECT j.id jobId,j.status,COALESCE(a.label,'Perfil não definido') accountLabel
    FROM publication_jobs j LEFT JOIN social_accounts a ON a.id=j.social_account_id
    WHERE j.organization_id=? AND j.vehicle_id=? AND j.id!=? AND j.status IN ('pending','filling','error','awaiting_confirmation','completed')
    ORDER BY CASE j.status WHEN 'completed' THEN 0 WHEN 'filling' THEN 1 ELSE 2 END,j.updated_at DESC LIMIT 1`)
    .get(organizationId, vehicleId, excludeJobId) as Record<string, unknown> | undefined
  if (sameVehicle) return {
    type: 'same_vehicle',
    ...sameVehicle,
    message: sameVehicle.status === 'completed'
      ? `Este veículo já possui um anúncio publicado no perfil ${sameVehicle.accountLabel}. Marque o anúncio anterior como removido antes de publicar novamente.`
      : `Este veículo já possui o trabalho #${sameVehicle.jobId} no perfil ${sameVehicle.accountLabel}. Retome o trabalho existente em vez de criar outro.`,
  }

  const sharedPhoto = db.prepare(`SELECT other.vehicle_id vehicleId,v.year,v.make,v.model,j.id jobId,j.status,COALESCE(a.label,'Perfil não definido') accountLabel,
      COUNT(DISTINCT target.content_hash) matchedPhotos
    FROM vehicle_images target JOIN vehicle_images other ON other.organization_id=target.organization_id
      AND other.content_hash=target.content_hash AND other.vehicle_id!=target.vehicle_id
    JOIN vehicles v ON v.id=other.vehicle_id JOIN publication_jobs j ON j.vehicle_id=other.vehicle_id AND j.organization_id=target.organization_id
    LEFT JOIN social_accounts a ON a.id=j.social_account_id
    WHERE target.organization_id=? AND target.vehicle_id=? AND target.content_hash!=''
      AND j.status IN ('pending','filling','error','awaiting_confirmation','completed')
    GROUP BY other.vehicle_id,j.id ORDER BY matchedPhotos DESC,j.updated_at DESC LIMIT 1`)
    .get(organizationId, vehicleId) as Record<string, unknown> | undefined
  if (sharedPhoto) return {
    type: 'shared_photo',
    ...sharedPhoto,
    message: `As fotos coincidem com o trabalho #${sharedPhoto.jobId} (${sharedPhoto.year} ${sharedPhoto.make} ${sharedPhoto.model}) no perfil ${sharedPhoto.accountLabel}. Use o cadastro existente ou remova o anúncio anterior antes de continuar.`,
  }
  return null
}
