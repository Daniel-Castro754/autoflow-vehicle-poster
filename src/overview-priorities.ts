export type OverviewVehicle = {
  status: string
  imageCount?: number
}
export type OverviewIncidentTotals = {
  open: number
  acknowledged: number
  critical: number
}

// Não inferir pendências a partir de dados ausentes: photo count desconhecido
// é diferente de 0; anúncios vendidos saem da fila de revisão fotográfica.
export function overviewActionCounts(
  vehicles: OverviewVehicle[],
  totals: OverviewIncidentTotals | null,
) {
  const noPhotos = vehicles.filter(
    (vehicle) => vehicle.imageCount === 0 && vehicle.status !== 'Vendido',
  ).length
  const attention = vehicles.filter((vehicle) => vehicle.status === 'Atenção').length
  const ready = vehicles.filter((vehicle) => vehicle.status === 'Pronto').length
  const openIncidents = Math.max(0, (totals?.open || 0) + (totals?.acknowledged || 0))
  const critical = Math.min(openIncidents, Math.max(0, totals?.critical || 0))
  return { noPhotos, attention, ready, openIncidents, critical }
}
