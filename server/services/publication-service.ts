import { randomInt } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  calculateListingHash,
  findDuplicateListingHash,
  listingSnapshotForVehicle,
  DuplicateListingHashError,
} from './duplicate-checker.ts'
import {
  pickRandomOrderedSubset,
  publicationPhotoRandom,
  signedPublicationPhotoToken,
} from './image-manager.ts'
import { profileLimits } from './profile-capacity.ts'

export type PublicationPhoto = { url: string; name: string; mimeType: string }

export function prepareListingForPublication(
  db: DatabaseSync,
  organizationId: number,
  publicationJobId: number,
  vehicleId: number,
  imageBaseUrl: string,
  approvedImages: PublicationPhoto[],
  imageVariantSecret: string,
) {
  const jobRow = db
    .prepare(
      'SELECT variant_seed variantSeed FROM publication_jobs WHERE id=? AND organization_id=?',
    )
    .get(publicationJobId, organizationId) as { variantSeed: number | null } | undefined
  const listing = listingSnapshotForVehicle(
    db,
    organizationId,
    vehicleId,
    jobRow?.variantSeed ?? undefined,
  )
  if (!listing) throw new Error('Veículo não encontrado para preparar a publicação.')
  const listingHash = calculateListingHash(listing)
  const existing = db
    .prepare(
      'SELECT listing_hash listingHash FROM published_ads WHERE organization_id=? AND publication_job_id=?',
    )
    .get(organizationId, publicationJobId) as { listingHash: string } | undefined
  if (existing && existing.listingHash !== listingHash)
    throw new Error(
      'Os dados do anúncio foram alterados após entrar na fila. Cancele e revise o trabalho.',
    )
  const duplicate = findDuplicateListingHash(db, organizationId, listingHash, publicationJobId)
  if (duplicate) throw new DuplicateListingHashError(duplicate.jobId)
  const rows = db
    .prepare(
      'SELECT id,file_name fileName,photo_category category FROM vehicle_images WHERE organization_id=? AND vehicle_id=?',
    )
    .all(organizationId, vehicleId) as Array<{ id: number; fileName: string; category: string }>
  const photosByUrl = new Map(rows.map((photo) => [imageBaseUrl + photo.fileName, photo]))
  const categorized = approvedImages.map((photo) => {
    const source = photosByUrl.get(photo.url)
    if (!source) throw new Error('A seleção contém uma fotografia não pertencente ao veículo.')
    return { ...photo, imageId: source.id, category: source.category }
  })
  const reordered = pickRandomOrderedSubset(
    categorized,
    20,
    publicationPhotoRandom(publicationJobId),
  )
  return {
    listingHash,
    content: listing,
    images: reordered.map(({ imageId, name }) => ({
      url:
        imageBaseUrl +
        `variants/${publicationJobId}/${imageId}/` +
        signedPublicationPhotoToken(imageVariantSecret, organizationId, publicationJobId, imageId) +
        '.jpg',
      name: name.replace(/\.[^.]+$/, '') + '-apresentacao.jpg',
      mimeType: 'image/jpeg',
    })),
  }
}

// Persist a cooldown rather than sleeping inside an HTTP request. It is
// additional to the existing configurable per-profile execution interval.
export function publishWithRandomDelay(
  db: DatabaseSync,
  organizationId: number,
  accountId: number,
  randomMinutes: number = randomInt(5, 21),
): { nextAllowedAt: string; extraMinutes: number } {
  if (!Number.isInteger(randomMinutes) || randomMinutes < 5 || randomMinutes > 20)
    throw new Error('Intervalo aleatório fora da faixa de 5 a 20 minutos.')
  const limits = profileLimits(db, organizationId, accountId)
  const nextAllowedAt = new Date(
    Date.now() + (limits.intervalMinutes + randomMinutes) * 60_000,
  ).toISOString()
  db.prepare(
    'UPDATE social_accounts SET next_publication_allowed_at=? WHERE organization_id=? AND id=?',
  ).run(nextAllowedAt, organizationId, accountId)
  return { nextAllowedAt, extraMinutes: randomMinutes }
}
