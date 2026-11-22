// Client-side packaging only. This code cannot import or publish any vehicle;
// the server still owns ZIP validation, stock permissions and preview/commit.
const MAX_PACKAGE_BYTES = 48 * 1024 * 1024
const MAX_CSV_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_IMAGES = 200

export interface FolderSource {
  name: string
  size: number
  webkitRelativePath: string
  arrayBuffer(): Promise<ArrayBuffer>
}

type ArchiveEntry = { name: string; source: FolderSource }

const encoder = new TextEncoder()
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function write16(bytes: Uint8Array, at: number, value: number) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(at, value, true)
}
function write32(bytes: Uint8Array, at: number, value: number) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(at, value, true)
}

function zipStored(entries: Array<{ name: string; bytes: Uint8Array }>): Blob {
  let offset = 0
  let directoryBytes = 0
  const prepared = entries.map(({ name, bytes }) => {
    const encodedName = encoder.encode(name)
    if (encodedName.byteLength > 0xffff) throw new Error('Nome de arquivo muito longo.')
    const checksum = crc32(bytes)
    const location = offset
    offset += 30 + encodedName.length + bytes.length
    directoryBytes += 46 + encodedName.length
    return { bytes, encodedName, checksum, location }
  })
  const total = offset + directoryBytes + 22
  if (total > MAX_PACKAGE_BYTES)
    throw new Error('Pasta acima de 48 MB. Divida o estoque em lotes menores.')
  const result = new Uint8Array(total)
  for (const entry of prepared) {
    const at = entry.location
    write32(result, at, 0x04034b50)
    write16(result, at + 4, 20) // ZIP version needed
    write16(result, at + 6, 0x0800) // UTF-8 filenames
    write16(result, at + 8, 0) // Store, no compression
    write32(result, at + 14, entry.checksum)
    write32(result, at + 18, entry.bytes.length)
    write32(result, at + 22, entry.bytes.length)
    write16(result, at + 26, entry.encodedName.length)
    result.set(entry.encodedName, at + 30)
    result.set(entry.bytes, at + 30 + entry.encodedName.length)
  }
  let pos = offset
  for (const entry of prepared) {
    write32(result, pos, 0x02014b50)
    write16(result, pos + 4, 20) // Version made by
    write16(result, pos + 6, 20)
    write16(result, pos + 8, 0x0800)
    write16(result, pos + 10, 0)
    write32(result, pos + 16, entry.checksum)
    write32(result, pos + 20, entry.bytes.length)
    write32(result, pos + 24, entry.bytes.length)
    write16(result, pos + 28, entry.encodedName.length)
    write32(result, pos + 42, entry.location)
    result.set(entry.encodedName, pos + 46)
    pos += 46 + entry.encodedName.length
  }
  write32(result, pos, 0x06054b50)
  write16(result, pos + 8, prepared.length)
  write16(result, pos + 10, prepared.length)
  write32(result, pos + 12, directoryBytes)
  write32(result, pos + 16, offset)
  return new Blob([result.buffer as ArrayBuffer], { type: 'application/zip' })
}

// Accept photos in fotos/CODE/01.jpg, or flat photos named CODE__01.jpg
// either beside the CSV or inside the fotos/ folder. Never guess a match
// from brand/model or fuzzy filename comparisons.
function archiveName(relativePath: string): { name: string; kind: 'csv' | 'photo' } | null {
  const segments = relativePath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'))
    throw new Error('A pasta contém um caminho inseguro: ' + relativePath)
  const filename = segments.at(-1)!
  if (/^(\.ds_store|thumbs\.db|desktop\.ini)$/i.test(filename)) return null
  if (segments.length === 1 && /\.csv$/i.test(filename))
    return { name: filename.toLowerCase(), kind: 'csv' }
  if (!/\.(jpe?g|png|webp)$/i.test(filename))
    throw new Error('Arquivo inesperado: ' + relativePath + '. Use somente CSV e fotos.')
  const flat = /^([a-z0-9._-]{1,64})__([0-9]{1,2})\.(jpe?g|png|webp)$/i.exec(filename)
  if ((segments.length === 1 || (segments.length === 2 && /^(fotos|photos)$/i.test(segments[0]!))) && flat) {
    return {
      name: `fotos/${flat[1]!.toLowerCase()}/${flat[2]!.padStart(2, '0')}.${flat[3]!.toLowerCase()}`,
      kind: 'photo',
    }
  }
  if (
    segments.length === 3 &&
    /^(fotos|photos)$/i.test(segments[0]!) &&
    /^[a-z0-9._-]{1,64}$/i.test(segments[1]!)
  ) {
    return {
      name: `fotos/${segments[1]!.toLowerCase()}/${filename.toLowerCase()}`,
      kind: 'photo',
    }
  }
  throw new Error(
    'Não foi possível associar a foto ' +
      relativePath +
      '. Use fotos/CODIGO/nome.jpg ou CODIGO__01.jpg.',
  )
}

export async function buildVehicleFolderZip(files: readonly FolderSource[]): Promise<{
  blob: Blob
  csvName: string
  photos: number
}> {
  if (!files.length) throw new Error('Selecione uma pasta com CSV e fotos.')
  const roots = new Set<string>()
  const keys = new Set<string>()
  const entries: ArchiveEntry[] = []
  let csvName = ''
  let photos = 0
  let size = 22
  for (const source of files) {
    const raw = source.webkitRelativePath.replaceAll('\\', '/')
    const segments = raw.split('/')
    if (segments.length < 2 || !segments[0])
      throw new Error('Selecione uma pasta completa, não apenas arquivos soltos.')
    roots.add(segments[0])
    if (roots.size !== 1) throw new Error('Selecione somente uma pasta de estoque por vez.')
    const mapped = archiveName(segments.slice(1).join('/'))
    if (!mapped) continue
    if (keys.has(mapped.name.toLowerCase()))
      throw new Error('Nomes de fotos repetidos após organizar: ' + mapped.name)
    keys.add(mapped.name.toLowerCase())
    if (!Number.isSafeInteger(source.size) || source.size < 1)
      throw new Error('Arquivo vazio ou com tamanho inválido: ' + raw)
    if (mapped.kind === 'csv') {
      if (csvName) throw new Error('A pasta deve conter exatamente um CSV na raiz.')
      if (source.size > MAX_CSV_BYTES) throw new Error('O CSV deve ter até 2 MB.')
      csvName = mapped.name
    } else {
      photos++
      if (photos > MAX_IMAGES) throw new Error('Máximo de 200 fotos por pacote.')
      if (source.size > MAX_IMAGE_BYTES) throw new Error('Cada foto deve ter até 12 MB: ' + raw)
    }
    size += 76 + encoder.encode(mapped.name).length * 2 + source.size
    if (size > MAX_PACKAGE_BYTES)
      throw new Error('Pasta acima de 48 MB. Divida o estoque em lotes menores.')
    entries.push({ name: mapped.name, source })
  }
  if (!csvName) throw new Error('Coloque um arquivo CSV na raiz da pasta escolhida.')
  if (!photos) throw new Error('A pasta não contém fotos associáveis aos códigos de estoque.')
  entries.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }))
  const packed: Array<{ name: string; bytes: Uint8Array }> = []
  for (const entry of entries) {
    const bytes = new Uint8Array(await entry.source.arrayBuffer())
    if (bytes.length !== entry.source.size) throw new Error('Arquivo alterado durante a leitura.')
    packed.push({ name: entry.name, bytes })
  }
  return { blob: zipStored(packed), csvName, photos }
}
