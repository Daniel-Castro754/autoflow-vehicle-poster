import { cp, mkdir, readFile, readdir, rm, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'extension')
const distDir = join(root, 'dist')
const unpackedDir = join(distDir, 'extension')
const manifest = JSON.parse(await readFile(join(sourceDir, 'manifest.json'), 'utf8'))
const zipPath = join(distDir, `autoflow-extension-v${manifest.version}.zip`)
const markerPath = join(distDir, '.autoflow-extension-build-pending')
const previousDir = join(distDir, '.autoflow-extension-previous')
const stageName = `.autoflow-extension-stage-${process.pid}-${randomUUID()}`
const stageDir = join(distDir, stageName)
const stagedZip = join(distDir, `${stageName}.zip`)

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

await mkdir(distDir, { recursive: true })
// A previous process may have crashed between renaming the old directory
// and publishing the replacement. Restore the old version before rebuilding.
if ((await exists(previousDir)) && !(await exists(unpackedDir))) {
  await rename(previousDir, unpackedDir)
}
await cp(sourceDir, stageDir, { recursive: true })

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let crc = n
  for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  crcTable[n] = crc >>> 0
}
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}
async function walk(dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(path)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

const localParts = []
const centralParts = []
let offset = 0
const stamp = dosDateTime()
for (const path of await walk(sourceDir)) {
  const data = await readFile(path)
  const name = Buffer.from(relative(sourceDir, path).replaceAll('\\', '/'))
  const crc = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt16LE(stamp.time, 10)
  local.writeUInt16LE(stamp.date, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)
  localParts.push(local, name, data)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt16LE(stamp.time, 12)
  central.writeUInt16LE(stamp.date, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(offset, 42)
  centralParts.push(central, name)
  offset += local.length + name.length + data.length
}

const centralDirectory = Buffer.concat(centralParts)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(0, 4)
end.writeUInt16LE(0, 6)
end.writeUInt16LE(centralParts.length / 2, 8)
end.writeUInt16LE(centralParts.length / 2, 10)
end.writeUInt32LE(centralDirectory.length, 12)
end.writeUInt32LE(offset, 16)
end.writeUInt16LE(0, 20)
// Package the ZIP in a temporary file before touching the current build.
await writeFile(stagedZip, Buffer.concat([...localParts, centralDirectory, end]))
await writeFile(markerPath, 'Atualização da extensão em andamento.\n')

let backedUp = false
let published = false
try {
  if (await exists(previousDir)) {
    // Stale backup from a previous completed-but-interrupted commit.
    // We can discard it only after the new outputs are fully staged.
    await rm(previousDir, { recursive: true })
  }
  if (await exists(unpackedDir)) {
    await rename(unpackedDir, previousDir)
    backedUp = true
  }
  await rename(stageDir, unpackedDir)
  published = true
  // Node's rename replaces an existing ZIP as part of one filesystem action.
  await rename(stagedZip, zipPath)
} catch (error) {
  // If the final ZIP was not published, keep the old unpacked extension.
  if (published) await rm(unpackedDir, { recursive: true, force: true })
  if (backedUp) await rename(previousDir, unpackedDir)
  throw error
} finally {
  await rm(stageDir, { recursive: true, force: true }).catch(() => {})
  await rm(stagedZip, { force: true }).catch(() => {})
}
// The new directory and ZIP are now published. Failure to delete an old
// backup must not report a working extension build as failed.
await rm(previousDir, { recursive: true, force: true }).catch(() => {})
await rm(markerPath, { force: true })

console.log(`Extensão MV3 pronta em ${relative(root, unpackedDir)}`)
console.log(`ZIP: ${relative(root, zipPath)}`)
