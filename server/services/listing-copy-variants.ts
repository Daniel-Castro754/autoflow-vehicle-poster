// Editorial presentation varies only for distinct inventory records. It does
// not change vehicle facts or authorize republishing the same physical vehicle.
//
// The optional `variantSeed` parameter lets a caller pick a different
// editorial combination for the SAME inventory record across separate
// publication cycles. When omitted, the seed falls back to the inventory id,
// preserving the original single-argument behavior for existing callers.

import { createHash } from 'node:crypto'

export type VehicleListingFacts = {
  id: number
  year: number
  make: string
  model: string
  trim: string
  description: string
  price: number
}

const descriptions = [
  'Confira as informações desta unidade.',
  'Veja os detalhes do veículo.',
  'Informações para sua avaliação.',
  'Conheça as características deste modelo.',
  'Detalhes importantes deste veículo.',
]

const endings = [
  'Entre em contato para confirmar a disponibilidade.',
  'Fale com a equipe para mais informações.',
  'Consulte a disponibilidade pelo chat.',
  'Estamos à disposição para esclarecer dúvidas.',
  'Agende uma visita e conheça o veículo.',
]

// Each order maps positions in [year, make, model, trim] to a title sequence.
const titleOrders: ReadonlyArray<readonly number[]> = [
  [0, 1, 2, 3],
  [1, 2, 3, 0],
  [1, 2, 0, 3],
  [2, 3, 0, 1],
]

function seedToIndex(seed: number | string, counter: number, modulo: number): number {
  if (modulo <= 0) return 0
  const hash = createHash('sha256').update(`${seed}:${counter}`).digest()
  return hash.readUInt32BE(0) % modulo
}

export function renderVehicleListingCopy(
  vehicle: VehicleListingFacts,
  variantSeed?: number | string,
) {
  if (!Number.isSafeInteger(vehicle.id) || vehicle.id <= 0)
    throw new Error('Identificador de estoque inválido.')
  const parts = [
    String(vehicle.year),
    vehicle.make.trim(),
    vehicle.model.trim(),
    vehicle.trim.trim(),
  ]
  const seed = variantSeed ?? vehicle.id
  const hasSeed = variantSeed !== undefined
  const legacyIndex = vehicle.id % 3
  const titleIndex = hasSeed ? seedToIndex(seed, 1, titleOrders.length) : legacyIndex
  const descriptionIndex = hasSeed ? seedToIndex(seed, 2, descriptions.length) : legacyIndex
  const endingIndex = hasSeed ? seedToIndex(seed, 3, endings.length) : legacyIndex
  const title = titleOrders[titleIndex]!.map((position) => parts[position])
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const description = [
    descriptions[descriptionIndex],
    vehicle.description.trim(),
    `Referência do estoque: AF-${String(vehicle.id).padStart(6, '0')}`,
    endings[endingIndex],
  ]
    .filter(Boolean)
    .join('\n\n')
  return { title, description, price: vehicle.price }
}
