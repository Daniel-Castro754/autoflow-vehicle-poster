export function generateVehicleHashtags(vehicle: {
  make: string
  model: string
  year?: number
  vehicleType?: string
  bodyType?: string
  location?: string
}): string[] {
  const sanitize = (text: string) =>
    text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]/g, '')

  const makeTag = sanitize(vehicle.make)
  const modelTag = sanitize(vehicle.model)
  const comboTag = sanitize(`${vehicle.make}${vehicle.model}`)

  const tags = new Set<string>()

  if (comboTag) tags.add(`#${comboTag}`)
  if (modelTag) tags.add(`#${modelTag}`)
  if (makeTag) tags.add(`#${makeTag}`)

  if (vehicle.year) {
    tags.add(`#${modelTag}${vehicle.year}`)
  }

  if (vehicle.bodyType && vehicle.bodyType !== 'Outro') {
    tags.add(`#${sanitize(vehicle.bodyType)}`)
  }

  if (vehicle.location) {
    const locParts = vehicle.location.split(',').map(s => s.trim())
    const state = locParts[1] ? sanitize(locParts[1]) : ''
    const city = locParts[0] ? sanitize(locParts[0]) : ''
    if (state) tags.add(`#Carros${state}`)
    if (city) tags.add(`#${city}Carros`)
  }

  tags.add('#CarrosSeminovos')
  tags.add('#VendaDeCarros')
  tags.add('#AutoMarketplace')

  return Array.from(tags).slice(0, 8)
}
