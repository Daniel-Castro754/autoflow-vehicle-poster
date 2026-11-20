// The inventory bulk action uses the same publication endpoint as a single vehicle.
// Process sequentially to preserve queue ordering, capacity checks and per-item errors.
export type BulkQueueVehicle = {
  id: number
  label: string
  imageCount?: number
}

export type BulkQueueFailure = {
  vehicleId: number
  label: string
  reason: string
}

export type BulkQueueOutcome = {
  succeeded: number[]
  failed: BulkQueueFailure[]
  total: number
}

export async function enqueueSelectedVehicles({
  vehicles,
  accountId,
  create,
  onProgress,
}: {
  vehicles: BulkQueueVehicle[]
  accountId: number
  create: (vehicleId: number, accountId: number) => Promise<unknown>
  onProgress?: (done: number, total: number) => void
}): Promise<BulkQueueOutcome> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0)
    throw new Error('Selecione um perfil do Brave válido.')
  const unique = [...new Map(vehicles.map((vehicle) => [vehicle.id, vehicle])).values()]
  if (!unique.length || unique.length > 25 || unique.some((vehicle) => !Number.isSafeInteger(vehicle.id) || vehicle.id <= 0))
    throw new Error('Selecione de 1 a 25 veículos válidos desta página.')

  const succeeded: number[] = []
  const failed: BulkQueueFailure[] = []
  for (const vehicle of unique) {
    try {
      // The server remains responsible for publication readiness, duplicate
      // evidence, crediting today's account capacity and write permissions.
      await create(vehicle.id, accountId)
      succeeded.push(vehicle.id)
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Falha desconhecida.'
      const photoNote =
        vehicle.imageCount === 0 && !/fot[oa]s?/i.test(detail)
          ? ' Este veículo está sem fotos cadastradas.'
          : ''
      failed.push({ vehicleId: vehicle.id, label: vehicle.label, reason: detail + photoNote })
      // If the API is offline, stop instead of queuing additional requests.
      if (error && typeof error === 'object' && 'status' in error && error.status === 0) {
        for (const remaining of unique.slice(succeeded.length + failed.length)) {
          failed.push({
            vehicleId: remaining.id,
            label: remaining.label,
            reason: 'Não enviado: conexão com a API indisponível.',
          })
        }
        onProgress?.(unique.length, unique.length)
        break
      }
    }
    onProgress?.(succeeded.length + failed.length, unique.length)
  }
  return { succeeded, failed, total: unique.length }
}
