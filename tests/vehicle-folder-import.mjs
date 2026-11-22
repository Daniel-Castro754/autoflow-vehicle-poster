import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { buildVehicleFolderZip } from '../src/vehicle-folder-package.ts'
import { parseVehiclePackage, readSafeZip } from '../server/services/vehicle-import-package.ts'

function file(relativePath, bytes) {
  const buffer = Buffer.from(bytes)
  return {
    name: relativePath.split('/').at(-1),
    webkitRelativePath: 'Estoque da loja/' + relativePath,
    size: buffer.length,
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  }
}

const csv = [
  'Estoque;Ano;Marca;Modelo;Versão;Preço;KM;TipoVeiculo;Localização;Câmbio;Combustível;Carroceria;CorExterna;CorInterna;Condição;Status;Descrição',
  'SAV-01;2021;Volkswagen;Saveiro;Trendline;64000;47000;Carro/picape;Criciúma - SC;Manual;Flex;Picape;Branco;Preto;Bom;Rascunho;Saveiro de teste',
  'FIAT-02;2022;Fiat;Fastback;Turbo;98000;18000;Carro/picape;Criciúma - SC;Automático;Flex;SUV;Cinza;Preto;Bom;Rascunho;Fastback de teste',
].join('\n')
const img1 = await sharp({
  create: { width: 80, height: 80, channels: 3, background: '#0088aa' },
}).png().toBuffer()
const img2 = await sharp({
  create: { width: 80, height: 80, channels: 3, background: '#aa9922' },
}).png().toBuffer()
const sources = [
  file('veiculos.csv', csv),
  file('SAV-01__01.png', img1),
  file('fotos/FIAT-02/01.png', img2),
]
const { blob, photos, csvName } = await buildVehicleFolderZip(sources)
assert.equal(photos, 2)
assert.equal(csvName, 'veiculos.csv')
assert.equal(blob.type, 'application/zip')
const zip = Buffer.from(await blob.arrayBuffer())
const entries = readSafeZip(zip)
assert.deepEqual([...entries.keys()].sort(), [
  'fotos/fiat-02/01.png',
  'fotos/sav-01/01.png',
  'veiculos.csv',
])
const parsed = await parseVehiclePackage(zip)
assert.equal(parsed.rows.length, 2)
assert.deepEqual(parsed.rowPhotos.map((row) => row.length), [1, 1])
assert.equal(parsed.rowPhotos[0][0].hash.length, 64)

const flatInPhotos = await buildVehicleFolderZip([
  file('veiculos.csv', csv),
  file('fotos/SAV-01__2.png', img1),
])
const flatParsed = await parseVehiclePackage(Buffer.from(await flatInPhotos.blob.arrayBuffer()))
assert.equal(flatParsed.rowPhotos[0].length, 1)
assert.equal(flatParsed.rowPhotos[1].length, 0)

async function reject(files, pattern) {
  await assert.rejects(buildVehicleFolderZip(files), pattern)
}
await reject([file('SAV-01__01.png', img1)], /CSV na raiz/)
await reject([file('veiculos.csv', csv)], /não contém fotos/)
await reject([...sources, file('outro.csv', csv)], /exatamente um CSV/)
await reject([...sources, file('relatorio.xlsx', 'x')], /Arquivo inesperado/)
await reject([...sources, file('fotos/OUTRO/01.png', img1), file('OUTRO__1.png', img1)], /repetidos/)
await reject([file('veiculos.csv', csv), file('fotos/../../secreto.png', img1)], /caminho inseguro/)
await reject(
  [file('veiculos.csv', csv), file('fotos/01.png', img1)],
  /Não foi possível associar/,
)
await reject([
  file('veiculos.csv', csv),
  ...Array.from({ length: 201 }, (_, i) => file('fotos/SAV-01/' + String(i + 1).padStart(3, '0') + '.png', img1)),
], /Máximo de 200 fotos/)

// Do not guess a vehicle from an image whose exact stock ID is absent from CSV.
const unmatched = await buildVehicleFolderZip([
  file('veiculos.csv', csv),
  file('OUTRO__01.png', img1),
])
await assert.rejects(
  parseVehiclePackage(Buffer.from(await unmatched.blob.arrayBuffer())),
  /fotos sem veículo correspondente/,
)

const view = readFileSync(new URL('../src/Vehicles.tsx', import.meta.url), 'utf8')
for (const token of [
  'Importar pasta',
  "setAttribute('webkitdirectory', '')",
  'buildVehicleFolderZip(Array.from(files))',
  "body: JSON.stringify({ zipBase64, mode, dryRun: true })",
  'setPackagePreview({ zipBase64, mode, summary: preview })',
]) {
  assert(view.includes(token), 'Missing stock folder UI contract: ' + token)
}
console.log('OK: pasta de estoque, fotos por código, ZIP íntegro e prévia obrigatória.')
