import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { prepareGoogleStockPackage } from '../server/services/google-stock-package.ts'
import { normalizeGoogleFileId } from '../server/services/google-stock-provider.ts'
import { parseVehiclePackage } from '../server/services/vehicle-import-package.ts'
import { csvVehicles } from '../server/services/vehicle-import.ts'

const rootFolderId = '1j3IoVthjsQNW6r1b_6gKSJWmCXh1CRlr'
const sheetId = '1_g-qQxmXXN21CddcuNKs05ltYiLkwHly_HcrJ0DpAOw'
const folderId = '1_a_mock_vehicle_folder_ID'
const otherFolderId = '1_a_mock_other_vehicle_ID'
const headers = [
  'Estoque', 'Sincronizar', 'PastaDriveId', 'Ano', 'Marca', 'Modelo', 'Versão',
  'Preço', 'KM', 'TipoVeiculo', 'Localização', 'Câmbio', 'Combustível',
  'Carroceria', 'CorExterna', 'CorInterna', 'Condição', 'Status', 'VIN', 'Observações internas',
]
const carRow = [
  'TESTE-01', 'SIM', folderId, 2022, 'Toyota', 'Corolla', 'XEi 2.0',
  119900, 42500, 'Carro/picape', 'Criciúma - SC', 'Automático', 'Flex',
  'Sedã', 'Prateado', 'Preto', 'Bom', 'Rascunho', '', 'Não sincronizar esta nota',
]
const anotherRow = [
  'TESTE-02', 'NÃO', otherFolderId, 2020, 'Honda', 'Civic', 'Touring',
  139900, 65000, 'Carro/picape', 'Criciúma - SC', 'Automático', 'Gasolina',
  'Sedã', 'Branco', 'Preto', 'Bom', 'Rascunho', '', 'ignorados',
]
const img1 = await sharp({
  create: { width: 64, height: 64, channels: 3, background: '#314a5e' },
}).jpeg().toBuffer()
const img2 = await sharp({
  create: { width: 64, height: 64, channels: 3, background: '#6e8195' },
}).png().toBuffer()
const text = Buffer.from(
  'Toyota {modelo} {versao} {ano}; valor {preco}, rodado {km} km. Consulte disponibilidade.',
)
const file = (id, name, mimeType, bytes) => ({
  id,
  name,
  mimeType,
  size: String(bytes.length),
  md5Checksum: createHash('md5').update(bytes).digest('hex'),
})
const photo1 = file('id_photo_01', '01_capa.jpg', 'image/jpeg', img1)
const photo2 = file('id_photo_02', '02_interior.png', 'image/png', img2)
const script = file('id_script', 'anuncio.txt', 'text/plain', text)
const ready = { id: 'id_ready', name: 'PRONTO.flag', mimeType: 'text/plain', size: '0' }
const allFiles = [photo1, script, photo2, ready]
const blobs = new Map([
  [photo1.id, img1],
  [photo2.id, img2],
  [script.id, text],
])

function source({
  rows = [headers, carRow, anotherRow],
  files = allFiles,
  parentId = rootFolderId,
} = {}) {
  return {
    spreadsheetRows: async (askedId) => {
      assert.equal(askedId, sheetId)
      return rows
    },
    folderInfo: async (id) => ({ id, name: 'Corolla', mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    listFiles: async (id) => {
      assert.equal(id, folderId)
      return files
    },
    download: async (id, limit) => {
      const bytes = blobs.get(id)
      assert(bytes, 'No unknown file may be downloaded')
      assert(bytes.length <= limit)
      return bytes
    },
  }
}
const data = await prepareGoogleStockPackage(source(), sheetId, rootFolderId)
assert.equal(data.selected, 1)
assert.equal(data.valid, 1)
assert.equal(data.ignored, 1)
assert.equal(data.photos, 2)
assert.equal(data.issues.length, 0)
assert.equal(data.vehicles[0].stockCode, 'TESTE-01')
assert.match(data.fingerprint, /^[a-f0-9]{64}$/)
const parsed = await parseVehiclePackage(Buffer.from(data.zipBase64, 'base64'))
assert.equal(parsed.rowPhotos[0].length, 2)
assert.deepEqual(parsed.rows.map((r) => r.stockCode), ['TESTE-01'])
const [row] = csvVehicles(parsed.csv)
assert.equal(row.make, 'Toyota')
assert.equal(row.description, 'Toyota Corolla XEi 2.0 2022; valor R$ 119.900,00, rodado 42.500 km. Consulte disponibilidade.')
assert(!parsed.csv.includes('Não sincronizar esta nota'), 'Never leak notes to descriptions')

const noMarker = await prepareGoogleStockPackage(
  source({ files: allFiles.filter((f) => f.id !== ready.id) }),
  sheetId,
  rootFolderId,
)
assert.equal(noMarker.valid, 0)
assert.match(noMarker.issues[0].message, /PRONTO.flag/)

const wrongFolder = await prepareGoogleStockPackage(
  source({ parentId: 'another_parent_folder_id' }),
  sheetId,
  rootFolderId,
)
assert.equal(wrongFolder.valid, 0)
assert.match(wrongFolder.issues[0].message, /diretamente dentro/)

const extraFile = await prepareGoogleStockPackage(
  source({ files: [...allFiles, { id: 'unknown', name: 'private.pdf', mimeType: 'application/pdf', size: '25' }] }),
  sheetId,
  rootFolderId,
)
assert.equal(extraFile.valid, 0)
assert.match(extraFile.issues[0].message, /Arquivos inesperados/)

const duplicated = await prepareGoogleStockPackage(
  source({ rows: [headers, carRow, carRow] }),
  sheetId,
  rootFolderId,
)
assert.equal(duplicated.valid, 1)
assert.equal(duplicated.issues.length, 1)
assert.match(duplicated.issues[0].message, /duplicado/)

await assert.rejects(
  prepareGoogleStockPackage(source({ rows: [['Veículo'], ['SIM']] }), sheetId, rootFolderId),
  /Coluna obrigatória/,
)
assert.equal(normalizeGoogleFileId('https://drive.google.com/drive/folders/' + rootFolderId), rootFolderId)
assert.equal(normalizeGoogleFileId('https://docs.google.com/spreadsheets/d/' + sheetId + '/edit'), sheetId)
assert.throws(() => normalizeGoogleFileId('file:///etc/passwd'), /ID ou link válido/)

console.log('OK: Google stock read-only, CSV/TXT and photos, root scope, READY flag, duplicates and ZIP parser')
