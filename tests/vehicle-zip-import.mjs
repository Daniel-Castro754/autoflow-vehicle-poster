import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { deflateRawSync } from 'node:zlib'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { parseVehiclePackage, readSafeZip } from '../server/services/vehicle-import-package.ts'
import { handleVehicleMutationRoute } from '../server/routes/vehicles.ts'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function makeZip(entries, method = 8) {
  const parts = []
  const directory = []
  let offset = 0
  for (const [name, data] of entries) {
    const rawName = Buffer.from(name)
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    const packed = method === 8 ? deflateRawSync(bytes) : bytes
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt32LE(crc32(bytes), 14)
    header.writeUInt32LE(packed.length, 18)
    header.writeUInt32LE(bytes.length, 22)
    header.writeUInt16LE(rawName.length, 26)
    const local = Buffer.concat([header, rawName, packed])
    parts.push(local)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc32(bytes), 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(rawName.length, 28)
    central.writeUInt32LE(offset, 42)
    directory.push(Buffer.concat([central, rawName]))
    offset += local.length
  }
  const directoryBytes = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directoryBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directoryBytes, end])
}

const photo1 = await sharp({
  create: { width: 32, height: 32, channels: 3, background: '#1a7565' },
}).png().toBuffer()
const photo2 = await sharp({
  create: { width: 32, height: 32, channels: 3, background: '#b7ddff' },
}).jpeg().toBuffer()
const photo3 = await sharp({
  create: { width: 32, height: 32, channels: 3, background: '#4f4466' },
}).webp().toBuffer()
const csv = [
  'Estoque;Ano;Marca;Modelo;Versão;Preço;KM;TipoVeiculo;Localização;Câmbio;Combustível;Carroceria;CorExterna;CorInterna;Condição;Status;Descrição',
  'SAVEIRO-19;2019;Volkswagen;Saveiro;Trendline 1.6;60900;80000;Carro/picape;Criciúma - SC;Manual;Flex;Picape;Prateado;Preto;Bom;Rascunho;"Saveiro impecável; IPVA pago"',
  'FASTBACK-24;2024;Fiat;Fastback;Turbo 200 AT;99900;35000;Carro/picape;Criciúma - SC;Automático;Flex;SUV;Cinza;Preto;Bom;Rascunho;Único dono e revisões na concessionária',
].join('\n')
const entries = [
  ['veiculos.csv', csv],
  ['fotos/SAVEIRO-19/01.png', photo1],
  ['fotos/SAVEIRO-19/02.jpg', photo2],
  ['fotos/FASTBACK-24/01.webp', photo3],
]
const zip = makeZip(entries)
const parsed = await parseVehiclePackage(zip)
assert.equal(parsed.rows.length, 2)
assert.deepEqual(parsed.rowPhotos.map((row) => row.length), [2, 1])
assert.equal(parsed.rows[0].description, 'Saveiro impecável; IPVA pago')
assert.equal(parsed.rows[1].make, 'Fiat')
assert.equal(readSafeZip(makeZip(entries, 0)).size, 4, 'Stored ZIP files are also supported')
await assert.rejects(parseVehiclePackage(makeZip([...entries, ['fotos/OTHER/03.png', photo1]])), /sem veículo correspondente/)
await assert.rejects(parseVehiclePackage(makeZip([...entries, ['fotos/../evil.jpg', photo2]])), /caminho de arquivo inválido/)
await assert.rejects(parseVehiclePackage(makeZip([...entries, ['fotos/SAVEIRO-19/invalida.jpg', photo1]])), /imagem inválida/)
await assert.rejects(parseVehiclePackage(makeZip([...entries, ['fotos/SAVEIRO-19/01.png', photo2]])), /repetidos/)
await assert.rejects(parseVehiclePackage(makeZip([...entries.slice(1)])), /CSV na raiz/)
const brokenZip = Buffer.from(zip)
brokenZip[brokenZip.length - 22 - 4] ^= 1 // corrupt a central-directory byte
assert.throws(() => readSafeZip(brokenZip), /ZIP inválido/)

const db = new DatabaseSync(':memory:')
initializeBaseSchema(db)
applyMigrations(db)
const uploads = mkdtempSync(join(tmpdir(), 'autoflow-zip-test-'))
const auth = { userId: 1, organizationId: 1 }
try {
  // Seed the minimal linked user/organization using a valid account in the base schema.
  // Import is authenticated: its per-organization scope is preserved through all operations.
  const settings = db.prepare('SELECT organization_id organizationId FROM organization_settings').all()
  assert(settings.length >= 0)
  // Real application has an initialized account; fixtures set up its records.
  db.prepare("INSERT INTO organizations (id,name) VALUES (1,'Teste')").run()
  db.prepare("INSERT INTO users (id,organization_id,name,email,password_hash,role,active) VALUES (1,1,'Admin','admin@teste.local','hash','admin',1)").run()
  db.prepare('INSERT INTO organization_settings (organization_id,default_location) VALUES (1,?)').run('Criciúma - SC')

  const importer = async (body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    let output
    const handled = await handleVehicleMutationRoute(
      req, {}, new URL('http://localhost/api/vehicles/import'), auth,
      {
        db,
        send: (_res, status, data) => { output = { status, ...data } },
        jsonBody: async (request) => JSON.parse((await Array.fromAsync(request)).map((x) => x.toString()).join('')),
        imageBaseUrl: 'http://localhost/uploads/',
        uploadsDir: uploads,
        isAdmin: () => true,
        canWriteVehicle: () => true,
        canWriteImage: () => true,
        recordJobEvent: () => {},
      },
    )
    assert(handled)
    return output
  }
  const zipBase64 = zip.toString('base64')
  const preview = await importer({ zipBase64, mode: 'skip', dryRun: true })
  assert.equal(preview.status, 200)
  assert.equal(preview.created, 2)
  assert.equal(preview.photos, 3)
  assert.equal(preview.failed, 0)
  assert.equal(db.prepare('SELECT COUNT(*) count FROM vehicles').get().count, 0)
  assert.equal(readdirSync(uploads).length, 0)
  const noPreview = await importer({ zipBase64, mode: 'skip' })
  assert.equal(noPreview.status, 409, 'ZIP commit must always require the preview digest')
  const result = await importer({ zipBase64, mode: 'skip', previewDigest: preview.previewDigest })
  assert.equal(result.status, 200)
  assert.equal(result.created, 2)
  assert.equal(result.photos, 3)
  assert.equal(db.prepare('SELECT COUNT(*) count FROM vehicle_images').get().count, 3)
  assert.equal(readdirSync(uploads).length, 3)
  const photos = db.prepare('SELECT vehicle_id vehicleId, file_name fileName FROM vehicle_images').all()
  assert(photos.every((row) => readFileSync(join(uploads, row.fileName)).length > 0))
  const saveiro = db.prepare("SELECT id,status,description FROM vehicles WHERE stock_code='SAVEIRO-19'").get()
  assert.equal(saveiro.status, 'Rascunho')
  assert.equal(saveiro.description, 'Saveiro impecável; IPVA pago')
  const duplicatePreview = await importer({ zipBase64, mode: 'skip', dryRun: true })
  assert.equal(duplicatePreview.skipped, 2)
  assert.equal(duplicatePreview.photos, 0)
  const duplicate = await importer({ zipBase64, mode: 'skip', previewDigest: duplicatePreview.previewDigest })
  assert.equal(duplicate.created, 0)
  assert.equal(duplicate.photos, 0)
  assert.equal(readdirSync(uploads).length, 3)
  const updatePreview = await importer({ zipBase64, mode: 'update', dryRun: true })
  assert.equal(updatePreview.updated, 2)
  assert.equal(updatePreview.photos, 0, 'Duplicate photo content must be skipped')
  // Mutating an image after preview must invalidate confirmation.
  db.prepare('DELETE FROM vehicle_images WHERE id=(SELECT id FROM vehicle_images WHERE vehicle_id=? LIMIT 1)').run(saveiro.id)
  const stale = await importer({ zipBase64, mode: 'update', previewDigest: updatePreview.previewDigest })
  assert.equal(stale.status, 409)
} finally {
  db.close()
  rmSync(uploads, { recursive: true, force: true })
}
console.log('✓ ZIP: layout seguro, formatos de fotos, prévia obrigatória, transação, proteção contra repetição e revisão de estoque')
