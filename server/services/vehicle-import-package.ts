import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import {
  csvVehicles,
  normalizeHeader,
  normalizeInventoryIdentifier,
  parseCsv,
} from './vehicle-import.ts'
import { validImageContent } from './vehicle-input.ts'

export const MAX_VEHICLE_ZIP_BYTES = 48 * 1024 * 1024
export const MAX_VEHICLE_ZIP_BODY_BYTES = Math.ceil((MAX_VEHICLE_ZIP_BYTES * 4) / 3) + 4096

const MAX_FILES = 250
const MAX_PHOTOS = 200
const MAX_ROWS = 100
const MAX_CSV_BYTES = 2 * 1024 * 1024
const MAX_PHOTO_BYTES = 12 * 1024 * 1024
const MAX_EXPANDED_BYTES = 140 * 1024 * 1024

export type PackagePhoto = {
  path: string
  originalName: string
  bytes: Buffer
  mime: string
  hash: string
}

export type VehiclePackage = {
  csv: string
  rows: Array<Record<string, unknown>>
  rowPhotos: PackagePhoto[][]
  archiveHash: string
  totalPhotos: number
}

function archiveError(reason: string): never {
  throw new Error('ZIP inválido: ' + reason)
}

function safePath(raw: string) {
  const path = raw.replaceAll('\\', '/')
  if (
    !path ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\0') ||
    path.includes('\uFFFD') ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  )
    archiveError('caminho de arquivo inválido ou inseguro.')
  return path
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(data: Buffer) {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// Read ZIP central directory without extracting to disk. Refuse archives whose
// size, compression or paths exceed a strict bound before inflation.
export function readSafeZip(buffer: Buffer): Map<string, Buffer> {
  if (buffer.length < 22 || buffer.length > MAX_VEHICLE_ZIP_BYTES)
    archiveError('o arquivo excede 48 MB ou não é um ZIP válido.')
  let end = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (
      buffer.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
    ) {
      end = i
      break
    }
  }
  if (end < 0) archiveError('diretório central não encontrado.')
  const count = buffer.readUInt16LE(end + 10)
  const directorySize = buffer.readUInt32LE(end + 12)
  const directoryOffset = buffer.readUInt32LE(end + 16)
  if (
    buffer.readUInt16LE(end + 4) !== 0 ||
    buffer.readUInt16LE(end + 6) !== 0 ||
    buffer.readUInt16LE(end + 8) !== count ||
    count < 1 ||
    count > MAX_FILES ||
    directoryOffset === 0xffffffff ||
    directorySize === 0xffffffff ||
    directoryOffset + directorySize > end
  )
    archiveError('ZIP dividido, ZIP64 ou quantidade excessiva de arquivos.')
  const result = new Map<string, Buffer>()
  let pos = directoryOffset
  let accumulated = 0
  for (let index = 0; index < count; index++) {
    if (pos + 46 > directoryOffset + directorySize || buffer.readUInt32LE(pos) !== 0x02014b50)
      archiveError('diretório central corrompido.')
    const flags = buffer.readUInt16LE(pos + 8)
    const method = buffer.readUInt16LE(pos + 10)
    const crc = buffer.readUInt32LE(pos + 16)
    const compressed = buffer.readUInt32LE(pos + 20)
    const expanded = buffer.readUInt32LE(pos + 24)
    const nameLength = buffer.readUInt16LE(pos + 28)
    const extraLength = buffer.readUInt16LE(pos + 30)
    const commentLength = buffer.readUInt16LE(pos + 32)
    const disk = buffer.readUInt16LE(pos + 34)
    const attributes = buffer.readUInt32LE(pos + 38)
    const offset = buffer.readUInt32LE(pos + 42)
    const next = pos + 46 + nameLength + extraLength + commentLength
    if (next > directoryOffset + directorySize) archiveError('nome de arquivo incompleto.')
    const rawName = buffer.subarray(pos + 46, pos + 46 + nameLength).toString('utf8')
    pos = next
    if (rawName.endsWith('/')) {
      if (compressed || expanded) archiveError('diretório com dados inválidos.')
      continue
    }
    const name = safePath(rawName)
    const key = name.toLowerCase()
    const unixMode = attributes >>> 16
    if (
      flags & 1 ||
      flags & 0x40 ||
      ![0, 8].includes(method) ||
      disk !== 0 ||
      (unixMode & 0xf000) === 0xa000 ||
      compressed === 0xffffffff ||
      expanded === 0xffffffff ||
      offset === 0xffffffff
    )
      archiveError('compactação, criptografia ou ligação de arquivo não suportada.')
    if (expanded > MAX_PHOTO_BYTES || compressed > MAX_VEHICLE_ZIP_BYTES)
      archiveError('arquivo interno excede o limite de 12 MB.')
    accumulated += expanded
    if (accumulated > MAX_EXPANDED_BYTES) archiveError('tamanho descompactado excessivo.')
    if (result.has(key)) archiveError('nomes de arquivo repetidos.')
    if (offset + 30 > directoryOffset || buffer.readUInt32LE(offset) !== 0x04034b50)
      archiveError('entrada de arquivo inválida.')
    const localMethod = buffer.readUInt16LE(offset + 8)
    const localNameLength = buffer.readUInt16LE(offset + 26)
    const localExtraLength = buffer.readUInt16LE(offset + 28)
    const localName = buffer.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8')
    const dataOffset = offset + 30 + localNameLength + localExtraLength
    if (
      localMethod !== method ||
      localName !== rawName ||
      dataOffset + compressed > directoryOffset
    )
      archiveError('entrada compactada inconsistente.')
    const compressedBytes = buffer.subarray(dataOffset, dataOffset + compressed)
    let bytes: Buffer
    try {
      bytes =
        method === 0
          ? Buffer.from(compressedBytes)
          : inflateRawSync(compressedBytes, {
              maxOutputLength: Math.min(MAX_PHOTO_BYTES, expanded) + 1,
            })
    } catch {
      archiveError('falha ao descompactar arquivo.')
    }
    if (bytes.length !== expanded || crc32(bytes) !== crc)
      archiveError('tamanho ou integridade CRC incorreta.')
    result.set(key, bytes)
  }
  if (pos !== directoryOffset + directorySize) archiveError('diretório central inconsistente.')
  return result
}

function imageMime(path: string) {
  const extension = path.split('.').pop()?.toLowerCase()
  return extension === 'png'
    ? 'image/png'
    : extension === 'webp'
      ? 'image/webp'
      : extension === 'jpg' || extension === 'jpeg'
        ? 'image/jpeg'
        : ''
}

export async function parseVehiclePackage(buffer: Buffer): Promise<VehiclePackage> {
  const entries = readSafeZip(buffer)
  const csvFiles = [...entries.keys()].filter((key) => !key.includes('/') && key.endsWith('.csv'))
  if (csvFiles.length !== 1) archiveError('inclua exatamente um CSV na raiz do ZIP.')
  const rawCsv = entries.get(csvFiles[0]!)!
  if (rawCsv.length > MAX_CSV_BYTES) archiveError('o CSV interno deve ter até 2 MB.')
  const csv = rawCsv.toString('utf8')
  if (csv.includes('\uFFFD')) archiveError('salve o CSV em UTF-8.')
  const rows = csvVehicles(csv, MAX_ROWS)
  if (rows.length < 1 || rows.length > MAX_ROWS)
    archiveError('o pacote deve conter de 1 a 100 veículos.')
  const csvTable = parseCsv(csv, MAX_ROWS)
  const headerKeys = csvTable[0]!.map(normalizeHeader)
  const imageColumns = headerKeys
    .map((key, index) => (/^image([1-9]|1[0-9]|20)$/.test(key) ? index : -1))
    .filter((index) => index >= 0)
  const photoFiles = [...entries.keys()].filter((key) => imageMime(key))
  if (photoFiles.length < 1 || photoFiles.length > MAX_PHOTOS)
    archiveError('inclua entre 1 e 200 fotos JPG, PNG ou WebP.')
  const used = new Set<string>()
  const stockSet = new Set<string>()
  const rowPhotos: PackagePhoto[][] = []
  for (let index = 0; index < rows.length; index++) {
    const code = normalizeInventoryIdentifier(rows[index]!.stockCode)
    if (!code) archiveError('cada veículo com fotos precisa da coluna Estoque preenchida.')
    if (stockSet.has(code)) archiveError('identificador de estoque repetido no CSV: ' + code)
    stockSet.add(code)
    const explicit = imageColumns
      .map((column) => csvTable[index + 1]?.[column]?.trim() || '')
      .filter(Boolean)
    const paths = explicit.length
      ? explicit.map((file) => safePath(file).toLowerCase())
      : photoFiles.filter((file) => {
          const parts = file.split('/')
          return (
            parts.length === 3 &&
            ['fotos', 'photos'].includes(parts[0]!) &&
            normalizeInventoryIdentifier(parts[1]) === code
          )
        })
    if (paths.length > 20) archiveError('o veículo ' + code + ' tem mais de 20 fotos.')
    const photos: PackagePhoto[] = []
    for (const path of paths) {
      if (!path.startsWith('fotos/') && !path.startsWith('photos/'))
        archiveError('as fotos devem estar dentro da pasta fotos/.')
      const bytes = entries.get(path)
      if (!bytes) archiveError('foto indicada no CSV não existe no ZIP: ' + path)
      if (used.has(path)) archiveError('foto associada a mais de um veículo: ' + path)
      const mime = imageMime(path)
      if (
        !mime ||
        !bytes.length ||
        bytes.length > MAX_PHOTO_BYTES ||
        !(await validImageContent(bytes, mime))
      )
        archiveError('imagem inválida ou incompatível: ' + path)
      used.add(path)
      photos.push({
        path,
        originalName: path.split('/').at(-1)!.slice(0, 200),
        bytes,
        mime,
        hash: createHash('sha256').update(bytes).digest('hex'),
      })
    }
    rowPhotos.push(photos)
  }
  if (used.size !== photoFiles.length)
    archiveError('há fotos sem veículo correspondente; confira as pastas pelo código de estoque.')
  for (const key of entries.keys()) {
    if (
      key !== csvFiles[0] &&
      !photoFiles.includes(key) &&
      !key.startsWith('__macosx/') &&
      !key.endsWith('.ds_store')
    )
      archiveError('arquivo inesperado no pacote: ' + key)
  }
  return {
    csv,
    rows,
    rowPhotos,
    archiveHash: createHash('sha256').update(buffer).digest('hex'),
    totalPhotos: used.size,
  }
}
