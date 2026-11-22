import { createHash } from 'node:crypto'
import { normalizeHeader, normalizeInventoryIdentifier } from './vehicle-import.ts'
import { normalizeGoogleFileId, GoogleStockError, type GoogleFile, type GoogleStockSource } from './google-stock-provider.ts'

const MAX_PACKAGE_BYTES = 48 * 1024 * 1024
const MAX_PHOTO_BYTES = 12 * 1024 * 1024
const MAX_PHOTOS = 200
const MAX_VEHICLES = 100
const MAX_SCRIPT_BYTES = 16 * 1024
const CSV_HEADERS = [
  'Estoque', 'Ano', 'Marca', 'Modelo', 'Versão', 'Preço', 'KM', 'TipoVeiculo',
  'Localização', 'Câmbio', 'Combustível', 'Carroceria', 'CorExterna',
  'CorInterna', 'Condição', 'Status', 'VIN', 'Descrição',
] as const
const fields = [
  'estoque', 'ano', 'marca', 'modelo', 'versao', 'preco', 'km', 'tipoveiculo',
  'localizacao', 'cambio', 'combustivel', 'carroceria', 'corexterna',
  'corinterna', 'condicao', 'status', 'vin',
] as const

export type GoogleStockIssue = { row: number; stockCode: string; message: string }
export type GoogleStockPrepared = {
  zipBase64: string
  selected: number
  valid: number
  photos: number
  ignored: number
  issues: GoogleStockIssue[]
  vehicles: Array<{ row: number; stockCode: string; label: string; photos: number }>
  fingerprint: string
}

type PreparedRow = { row: number; stockCode: string; values: string[]; photos: Array<{ name: string; bytes: Buffer }> }

function csvCell(value: unknown) {
  const raw = String(value ?? '')
  return '"' + raw.replaceAll('"', '""') + '"'
}
function imageMime(filename: string) {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  return null
}
function renderTemplate(template: string, lookup: Record<string, string>) {
  return template.replace(/\{(ano|marca|modelo|versao|preco|km|codigo)\}/gi, (_, key: string) => {
    const normalized = key.toLowerCase()
    if (normalized === 'preco') {
      const value = Number(lookup.preco)
      return Number.isFinite(value) ? value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : ''
    }
    if (normalized === 'km') {
      const value = Number(lookup.km)
      return Number.isFinite(value) ? value.toLocaleString('pt-BR') : ''
    }
    return lookup[normalized] || ''
  })
}
function safeImageName(name: string) {
  if (
    name.length < 5 ||
    name.length > 150 ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name === '.' ||
    name === '..' ||
    !/^[^<>:"|?*\x00-\x1f]+$/u.test(name)
  )
    throw new GoogleStockError(422, 'Nome de foto inválido na pasta do Google Drive.')
  return name
}
function bytesLimit(meta: GoogleFile, max: number) {
  const n = Number(meta.size)
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new GoogleStockError(422, 'Arquivo vazio, sem tamanho definido ou acima do limite: ' + meta.name)
  return n
}
function crc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
export function buildGoogleStockZip(csv: string, photos: Array<{ name: string; bytes: Buffer }>): Buffer {
  const entries = [{ name: 'veiculos.csv', bytes: Buffer.from(csv, 'utf8') }, ...photos]
  if (entries.length < 2 || entries.length > 202)
    throw new GoogleStockError(422, 'O pacote deve ter CSV e entre 1 e 200 fotos.')
  const local: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const { name, bytes } of entries) {
    const filename = Buffer.from(name, 'utf8')
    if (!filename.length || filename.length > 65535 || bytes.length > MAX_PHOTO_BYTES)
      throw new GoogleStockError(422, 'Arquivo ZIP fora dos limites.')
    const checksum = crc32(bytes)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6) // UTF-8 names
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(bytes.length, 18)
    header.writeUInt32LE(bytes.length, 22)
    header.writeUInt16LE(filename.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt32LE(checksum, 16)
    dir.writeUInt32LE(bytes.length, 20)
    dir.writeUInt32LE(bytes.length, 24)
    dir.writeUInt16LE(filename.length, 28)
    dir.writeUInt32LE(offset, 42)
    local.push(header, filename, bytes)
    directory.push(dir, filename)
    offset += header.length + filename.length + bytes.length
    if (offset > MAX_PACKAGE_BYTES)
      throw new GoogleStockError(422, 'O pacote do Google Drive excedeu 48 MB. Divida o lote.')
  }
  const central = Buffer.concat(directory)
  const ending = Buffer.alloc(22)
  ending.writeUInt32LE(0x06054b50, 0)
  ending.writeUInt16LE(entries.length, 8)
  ending.writeUInt16LE(entries.length, 10)
  ending.writeUInt32LE(central.length, 12)
  ending.writeUInt32LE(offset, 16)
  const zip = Buffer.concat([...local, central, ending])
  if (zip.length > MAX_PACKAGE_BYTES)
    throw new GoogleStockError(422, 'O pacote do Google Drive excedeu 48 MB. Divida o lote.')
  return zip
}

// Entire operation is read-only. It prepares a ZIP that the existing /vehicles/import
// endpoint must preview and later confirm. Never queues or publishes listings.
export async function prepareGoogleStockPackage(
  source: GoogleStockSource,
  spreadsheetId: string,
  rootFolderId: string,
): Promise<GoogleStockPrepared> {
  const rows = await source.spreadsheetRows(spreadsheetId)
  if (!rows.length || !Array.isArray(rows[0]))
    throw new GoogleStockError(422, 'A aba Veiculos precisa conter os cabeçalhos do modelo.')
  const index = new Map<string, number>()
  for (let i = 0; i < rows[0].length; i++) {
    const name = normalizeHeader(rows[0][i])
    if (!name) continue
    if (index.has(name)) throw new GoogleStockError(422, 'Cabeçalho duplicado: ' + name)
    index.set(name, i)
  }
  for (const name of [...fields, 'sincronizar', 'pastadriveid'])
    if (!index.has(name))
      throw new GoogleStockError(422, 'Coluna obrigatória ausente na planilha: ' + name)
  if (rows.length > MAX_VEHICLES + 1)
    throw new GoogleStockError(422, 'Planilha acima de 100 veículos. Divida os lotes.')
  const read = (row: unknown[], col: string): string => String(row[index.get(col)!] ?? '').trim()
  const issues: GoogleStockIssue[] = []
  const prepared: PreparedRow[] = []
  const seen = new Set<string>()
  let selected = 0
  let ignored = 0
  let photosTotal = 0
  let estimatedSize = 4096

  for (let n = 1; n < rows.length; n++) {
    const cells = rows[n]
    if (!Array.isArray(cells)) continue
    const sync = read(cells, 'sincronizar').toUpperCase()
    if (sync !== 'SIM') {
      ignored++
      continue
    }
    selected++
    const stockCode = normalizeInventoryIdentifier(read(cells, 'estoque'))
    const row = n + 1
    const reject = (message: string) => { issues.push({ row, stockCode, message }) }
    if (!/^[A-Z0-9._-]{1,64}$/.test(stockCode)) {
      reject('Informe um código de estoque único sem espaços, barras ou caracteres especiais.')
      continue
    }
    if (seen.has(stockCode)) {
      reject('Código duplicado na planilha; não é possível escolher qual cadastro é o correto.')
      continue
    }
    seen.add(stockCode)
    let folderId = ''
    try {
      folderId = normalizeGoogleFileId(read(cells, 'pastadriveid'))
    } catch {
      reject('Cole o link ou ID da pasta individual do veículo.')
      continue
    }
    const lookup = Object.fromEntries(fields.map((key) => [key, read(cells, key)]))
    lookup.status = lookup.status || 'Rascunho'
    lookup.codigo = stockCode
    if (!['Rascunho', 'Pronto'].includes(lookup.status)) {
      reject('Status permitido na sincronização: Rascunho ou Pronto.')
      continue
    }
    if (!/^\d{4}$/.test(lookup.ano || '') ||
        !/^[0-9]+(?:\.[0-9]+)?$/.test(lookup.preco || '') ||
        !/^\d+$/.test(lookup.km || '')) {
      reject('Ano, Preço e KM precisam estar preenchidos como números sem separadores.')
      continue
    }
    let folder: GoogleFile
    let files: GoogleFile[]
    try {
      folder = await source.folderInfo(folderId)
      if (folder.mimeType !== 'application/vnd.google-apps.folder' ||
          !folder.parents?.includes(rootFolderId)) {
        reject('A pasta do veículo deve estar diretamente dentro da pasta Veiculos configurada.')
        continue
      }
      files = await source.listFiles(folderId)
    } catch (error) {
      if (error instanceof GoogleStockError) reject(error.message)
      else reject('Não foi possível ler a pasta individual do Drive.')
      continue
    }
    const matching = (name: string) => files.filter((file) => file.name.toLowerCase() === name)
    if (matching('pronto.flag').length !== 1) {
      reject('Pasta ainda não liberada: inclua PRONTO.flag após terminar os arquivos.')
      continue
    }
    const scriptFiles = matching('anuncio.txt')
    if (scriptFiles.length !== 1 || scriptFiles[0]!.mimeType.startsWith('application/vnd.google-apps.')) {
      reject('A pasta precisa ter exatamente um anuncio.txt de texto simples (não Google Docs).')
      continue
    }
    const imageFiles = files.filter((file) => imageMime(file.name))
    const allowed = new Set([...matching('pronto.flag'), ...scriptFiles, ...imageFiles].map(f=>f.id))
    if (files.some((file) => !allowed.has(file.id))) {
      reject('Arquivos inesperados na pasta; mantenha somente anuncio.txt, PRONTO.flag e as fotos.')
      continue
    }
    if (!imageFiles.length || imageFiles.length > 20) {
      reject('Cada veículo precisa ter entre 1 e 20 fotos.')
      continue
    }
    const names = new Set<string>()
    if (imageFiles.some((file) => {
      const lower = file.name.toLowerCase()
      if (names.has(lower)) return true
      names.add(lower)
      return false
    })) {
      reject('Há nomes de fotos repetidos na pasta.')
      continue
    }
    try {
      bytesLimit(scriptFiles[0]!, MAX_SCRIPT_BYTES)
      for (const photo of imageFiles) {
        safeImageName(photo.name)
        bytesLimit(photo, MAX_PHOTO_BYTES)
        if (!imageMime(photo.name) || !photo.mimeType.startsWith('image/'))
          throw new GoogleStockError(422, 'Arquivo de foto não reconhecido: ' + photo.name)
      }
      if (photosTotal + imageFiles.length > MAX_PHOTOS)
        throw new GoogleStockError(422, 'O lote excederia 200 fotos. Divida a planilha em lotes.')
      const predicted = imageFiles.reduce((sum, file) => sum + Number(file.size), 0)
      if (estimatedSize + predicted > MAX_PACKAGE_BYTES - 64 * 1024)
        throw new GoogleStockError(422, 'Lote acima de 48 MB; reduza o número de fotos.')
      const scriptBytes = await source.download(scriptFiles[0]!.id, MAX_SCRIPT_BYTES)
      if (scriptBytes.length !== Number(scriptFiles[0]!.size))
        throw new GoogleStockError(409, 'anuncio.txt mudou durante a leitura. Gere outra prévia.')
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const original = decoder.decode(scriptBytes).replace(/^\uFEFF/, '').trim()
      if (!original || original.includes('\0'))
        throw new GoogleStockError(422, 'anuncio.txt deve conter texto UTF-8 válido.')
      const description = renderTemplate(original, lookup)
      const ordered = [...imageFiles].sort((a, b) =>
        a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }),
      )
      const downloaded: Array<{ name: string; bytes: Buffer }> = []
      for (const photo of ordered) {
        const bytes = await source.download(photo.id, MAX_PHOTO_BYTES)
        if (bytes.length !== Number(photo.size))
          throw new GoogleStockError(409, 'Uma foto mudou durante a leitura. Gere outra prévia.')
        if (photo.md5Checksum &&
            createHash('md5').update(bytes).digest('hex') !== photo.md5Checksum)
          throw new GoogleStockError(409, 'Uma foto foi modificada durante a leitura. Gere outra prévia.')
        downloaded.push({ name: 'fotos/' + stockCode + '/' + photo.name, bytes })
      }
      photosTotal += downloaded.length
      estimatedSize += predicted + scriptBytes.length + 4096
      prepared.push({
        row,
        stockCode,
        values: [...fields.map((key) => lookup[key] || ''), description],
        photos: downloaded,
      })
    } catch (error) {
      reject(error instanceof GoogleStockError ? error.message : 'Arquivo inválido ou indisponível no Drive.')
    }
  }
  const vehicles = prepared.map((item) => ({
    row: item.row,
    stockCode: item.stockCode,
    label: [item.values[1], item.values[2], item.values[3]].filter(Boolean).join(' '),
    photos: item.photos.length,
  }))
  const zip = prepared.length
    ? buildGoogleStockZip(
        CSV_HEADERS.join(';') + '\n' + prepared.map((item) => item.values.map(csvCell).join(';')).join('\n'),
        prepared.flatMap((item) => item.photos),
      )
    : null
  return {
    zipBase64: zip?.toString('base64') || '',
    selected,
    valid: prepared.length,
    photos: photosTotal,
    ignored,
    issues,
    vehicles,
    fingerprint: zip ? createHash('sha256').update(zip).digest('hex') : '',
  }
}
