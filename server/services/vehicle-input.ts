import type { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'

export const vehicleOptions = {
  vehicleType: new Set([
    'Carro/picape',
    'Motocicleta',
    'Veículos para esportes',
    'Trailer',
    'Reboque',
    'Barco',
    'Comercial/industrial',
    'Outro',
  ]),
  make: new Set([
    'AM General',
    'Agrale',
    'Alfa Romeo',
    'Aston Martin',
    'Audi',
    'BMW',
    'Bentley',
    'BYD',
    'Cadillac',
    'Caoa Chery',
    'Chery',
    'Chevrolet',
    'Chrysler',
    'Citroën',
    'Cross Lander',
    'Cupra',
    'DS',
    'Daewoo',
    'Daihatsu',
    'Dodge',
    'Effa',
    'Ferrari',
    'Fiat',
    'Ford',
    'Geely',
    'GWM',
    'Honda',
    'Hyundai',
    'Iveco',
    'JAC',
    'Jaecoo',
    'Jaguar',
    'Jeep',
    'Kia',
    'Lamborghini',
    'Land Rover',
    'Lexus',
    'Lifan',
    'Maserati',
    'Mazda',
    'Mercedes-Benz',
    'Mini',
    'Mitsubishi',
    'Nissan',
    'Omoda',
    'Peugeot',
    'Porsche',
    'RAM',
    'Renault',
    'Rolls-Royce',
    'Seat',
    'Smart',
    'SsangYong',
    'Subaru',
    'Suzuki',
    'Tesla',
    'Toyota',
    'Troller',
    'Volkswagen',
    'Volvo',
    'Outra',
  ]),
  transmission: new Set(['Automático', 'Manual', 'Automatizado']),
  fuelType: new Set([
    'Flex',
    'Gasolina',
    'Diesel',
    'Elétrico',
    'Híbrido',
    'Etanol',
    'GNV',
    'Outro',
  ]),
  bodyType: new Set([
    'Conversível',
    'Cupê',
    'Hatch',
    'Minivan',
    'Picape',
    'Sedã',
    'SUV',
    'Perua',
    'Van',
    'Outro',
  ]),
  condition: new Set(['Excelente', 'Muito bom', 'Bom', 'Regular', 'Ruim']),
  color: new Set([
    'Preto',
    'Azul',
    'Marrom',
    'Dourado',
    'Verde',
    'Cinza',
    'Rosa',
    'Roxo',
    'Vermelho',
    'Prateado',
    'Laranja',
    'Branco',
    'Amarelo',
    'Carvão',
    'Off-white',
    'Bronze',
    'Bege',
    'Bordô',
  ]),
  status: new Set(['Rascunho', 'Pronto', 'Publicado', 'Atenção', 'Vendido']),
}

function hasCompleteImageContainer(bytes: Buffer, mime: string) {
  if (mime === 'image/jpeg')
    return bytes.length >= 4 && bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))
  if (mime === 'image/webp')
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.readUInt32LE(4) + 8 === bytes.length &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  if (mime === 'image/png') {
    if (
      bytes.length < 20 ||
      !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    )
      return false
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset)
      if (length > bytes.length - offset - 12) return false
      const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
      offset += length + 12
      if (type === 'IEND') return length === 0 && offset === bytes.length
    }
    return false
  }
  return false
}

export async function validImageContent(bytes: Buffer, mime: string) {
  const expectedFormat =
    mime === 'image/jpeg'
      ? 'jpeg'
      : mime === 'image/png'
        ? 'png'
        : mime === 'image/webp'
          ? 'webp'
          : null
  if (!expectedFormat || !hasCompleteImageContainer(bytes, mime)) return false
  try {
    const decoder = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' })
    const metadata = await decoder.metadata()
    if (
      metadata.format !== expectedFormat ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > 40_000_000 ||
      (metadata.pages ?? 1) > 1
    )
      return false
    await decoder.stats()
    return true
  } catch {
    return false
  }
}

export function applyVehicleDefaults(
  db: DatabaseSync,
  body: Record<string, unknown>,
  organizationId: number,
): Record<string, unknown> {
  const settings = db
    .prepare(
      'SELECT default_location defaultLocation,description_template descriptionTemplate FROM organization_settings WHERE organization_id=?',
    )
    .get(organizationId) as { defaultLocation?: string; descriptionTemplate?: string } | undefined
  const location =
    String(body.location || '').trim() || String(settings?.defaultLocation || '').trim()
  let description = String(body.description || '').trim()
  if (!description) {
    const template =
      String(settings?.descriptionTemplate || '').trim() ||
      '{ano} {marca} {modelo} {versao} com {km} km. Entre em contato para mais informações.'
    const values: Record<string, string> = {
      ano: String(body.year || ''),
      marca: String(body.make || ''),
      modelo: String(body.model || ''),
      versao: String(body.trim || ''),
      km: Number.isFinite(Number(body.km)) ? Number(body.km).toLocaleString('pt-BR') : '',
    }
    description = template
      .replace(
        /\{(ano|marca|modelo|versao|km)\}/gi,
        (_, key: string) => values[key.toLowerCase()] || '',
      )
      .trim()
  }
  return { ...body, location, description }
}

export function validateVehicleBody(body: Record<string, unknown>) {
  const year = Number(body.year),
    price = Number(body.price),
    km = Number(body.km)
  if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear() + 1)
    return 'Selecione um ano válido.'
  if (!vehicleOptions.make.has(String(body.make))) return 'Selecione uma fabricante da lista.'
  if (!String(body.model || '').trim()) return 'O modelo é obrigatório.'
  if (!String(body.location || '').trim()) return 'A localização é obrigatória.'
  if (!Number.isFinite(price) || price <= 0) return 'Informe um preço maior que zero.'
  if (!Number.isFinite(km) || km < 0) return 'Informe uma quilometragem válida.'
  if (!vehicleOptions.vehicleType.has(String(body.vehicleType)))
    return 'Selecione um tipo de veículo válido.'
  if (!vehicleOptions.transmission.has(String(body.transmission)))
    return 'Selecione um câmbio válido.'
  if (!vehicleOptions.fuelType.has(String(body.fuelType))) return 'Selecione um combustível válido.'
  if (!vehicleOptions.bodyType.has(String(body.bodyType))) return 'Selecione uma carroceria válida.'
  if (!vehicleOptions.condition.has(String(body.condition))) return 'Selecione uma condição válida.'
  if (!vehicleOptions.color.has(String(body.exteriorColor)))
    return 'Selecione uma cor externa da lista.'
  if (!vehicleOptions.color.has(String(body.interiorColor)))
    return 'Selecione uma cor interna da lista.'
  if (!vehicleOptions.status.has(String(body.status || 'Rascunho')))
    return 'Selecione um status válido.'
  if (!String(body.description || '').trim()) return 'A descrição é obrigatória.'
  return ''
}
