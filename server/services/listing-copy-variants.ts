// Editorial presentation varies only for distinct inventory records. It does
// not change vehicle facts or authorize republishing the same physical vehicle.
export type VehicleListingFacts = {
  id: number
  year: number
  make: string
  model: string
  trim: string
  description: string
  price: number
}

export function renderVehicleListingCopy(vehicle: VehicleListingFacts) {
  if (!Number.isSafeInteger(vehicle.id) || vehicle.id <= 0)
    throw new Error('Identificador de estoque inválido.')
  const year = String(vehicle.year)
  const make = vehicle.make.trim()
  const model = vehicle.model.trim()
  const trim = vehicle.trim.trim()
  const descriptions = [
    'Confira as informações desta unidade.',
    'Veja os detalhes do veículo.',
    'Informações para sua avaliação.',
  ]
  const endings = [
    'Entre em contato para confirmar a disponibilidade.',
    'Fale com a equipe para mais informações.',
    'Consulte a disponibilidade pelo chat.',
  ]
  const titles = [
    [year, make, model, trim],
    [make, model, trim, year],
    [make, model, year, trim],
  ]
  const index = vehicle.id % titles.length
  const title = titles[index]!.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  const description = [
    descriptions[index],
    vehicle.description.trim(),
    `Referência do estoque: AF-${String(vehicle.id).padStart(6, '0')}`,
    endings[index],
  ].filter(Boolean).join('\n\n')
  return { title, description, price: vehicle.price }
}
