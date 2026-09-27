import type { DatabaseSync } from 'node:sqlite'

const headerAliases: Record<string, string> = {
  estoque: 'stockCode',
  codigoestoque: 'stockCode',
  codestoque: 'stockCode',
  stock: 'stockCode',
  stockcode: 'stockCode',
  idestoque: 'stockCode',
  vin: 'vin',
  chassi: 'vin',
  chassis: 'vin',
  ano: 'year',
  year: 'year',
  marca: 'make',
  fabricante: 'make',
  make: 'make',
  modelo: 'model',
  model: 'model',
  versao: 'trim',
  versão: 'trim',
  trim: 'trim',
  preco: 'price',
  preço: 'price',
  price: 'price',
  km: 'km',
  quilometragem: 'km',
  mileage: 'km',
  tipoveiculo: 'vehicleType',
  tipodeveiculo: 'vehicleType',
  vehicletype: 'vehicleType',
  localizacao: 'location',
  localização: 'location',
  location: 'location',
  cambio: 'transmission',
  câmbio: 'transmission',
  transmissao: 'transmission',
  transmissão: 'transmission',
  transmission: 'transmission',
  combustivel: 'fuelType',
  combustível: 'fuelType',
  fuel: 'fuelType',
  fueltype: 'fuelType',
  carroceria: 'bodyType',
  bodytype: 'bodyType',
  bodystyle: 'bodyType',
  corexterna: 'exteriorColor',
  exteriorcolor: 'exteriorColor',
  corinterna: 'interiorColor',
  interiorcolor: 'interiorColor',
  condicao: 'condition',
  condição: 'condition',
  condition: 'condition',
  descricao: 'description',
  descrição: 'description',
  description: 'description',
  status: 'status',
}

export function normalizeHeader(value: unknown) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

export function normalizeInventoryIdentifier(value: unknown) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .slice(0, 64)
}

export function validateInventoryIdentifiers(stockCode: string, vin: string) {
  if (stockCode && !/^[A-Z0-9._/-]{1,64}$/.test(stockCode))
    return 'O identificador de estoque contém caracteres não suportados.'
  if (vin && !/^[A-Z0-9-]{5,32}$/.test(vin))
    return 'O VIN/chassi deve ter entre 5 e 32 caracteres alfanuméricos.'
  return ''
}

function countDelimiter(line: string, delimiter: string) {
  let count = 0
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') index++
      else quoted = !quoted
    } else if (!quoted && character === delimiter) count++
  }
  return count
}

export function detectCsvDelimiter(text: string) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || ''
  const candidates = [',', ';', '\t']
  return candidates
    .map((delimiter) => ({ delimiter, count: countDelimiter(firstLine, delimiter) }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter || ','
}

export function parseCsv(text: string, maxRows = 2000): string[][] {
  const source = String(text || '').replace(/^\uFEFF/, '')
  const delimiter = detectCsvDelimiter(source)
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false

  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"'
        index++
      } else quoted = !quoted
      continue
    }
    if (!quoted && character === delimiter) {
      row.push(value.trim())
      value = ''
      continue
    }
    if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && source[index + 1] === '\n') index++
      row.push(value.trim())
      value = ''
      if (row.some((item) => item !== '')) rows.push(row)
      row = []
      if (rows.length > maxRows + 1) throw new Error(`O CSV excede o limite de ${maxRows} linhas.`)
      continue
    }
    value += character
  }
  if (quoted) throw new Error('O CSV possui aspas não fechadas.')
  row.push(value.trim())
  if (row.some((item) => item !== '')) rows.push(row)
  if (rows.length > maxRows + 1) throw new Error(`O CSV excede o limite de ${maxRows} linhas.`)
  return rows
}

export function csvVehicles(text: string, maxRows = 2000): Array<Record<string, unknown>> {
  const rows = parseCsv(text, maxRows)
  if (rows.length < 2) return []
  const headers = rows[0].map((header) => headerAliases[normalizeHeader(header)] || '')
  if (!headers.some(Boolean)) throw new Error('Nenhuma coluna reconhecida foi encontrada no CSV.')
  return rows.slice(1).map((values) => {
    const vehicle: Record<string, unknown> = {}
    headers.forEach((field, index) => {
      if (field) vehicle[field] = values[index] ?? ''
    })
    vehicle.stockCode = normalizeInventoryIdentifier(vehicle.stockCode)
    vehicle.vin = normalizeInventoryIdentifier(vehicle.vin)
    if (!vehicle.status) vehicle.status = 'Rascunho'
    return vehicle
  })
}

export function findVehicleIdentifierConflict(
  db: DatabaseSync,
  organizationId: number,
  stockCode: string,
  vin: string,
  excludeVehicleId = 0,
) {
  const normalizedStock = normalizeInventoryIdentifier(stockCode)
  const normalizedVin = normalizeInventoryIdentifier(vin)
  if (!normalizedStock && !normalizedVin) return null
  return db
    .prepare(
      `SELECT id,stock_code stockCode,vin FROM vehicles
      WHERE organization_id=? AND id<>? AND (
        (?<>'' AND stock_code<>'' AND stock_code=? COLLATE NOCASE) OR
        (?<>'' AND vin<>'' AND vin=? COLLATE NOCASE)
      ) LIMIT 1`,
    )
    .get(
      organizationId,
      excludeVehicleId,
      normalizedStock,
      normalizedStock,
      normalizedVin,
      normalizedVin,
    ) as { id: number; stockCode: string; vin: string } | undefined
}
