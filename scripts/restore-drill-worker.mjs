import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statfsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { restoreBackup, verifyBackup } from './backup.mjs'

const directory = process.argv[2]
const sandboxParent = process.argv[3]
let temporary = null
let response
try {
  if (!directory || !sandboxParent || process.argv.length !== 4) throw new Error('INVALID_BACKUP')
  // Validate the input first, before allocating staging space or copying a file.
  const manifest = verifyBackup(directory)
  const totalBytes = manifest.database.bytes +
    manifest.uploads.reduce((sum, item) => sum + item.bytes, 0) +
    (manifest.vault?.bytes || 0)
  if (!Number.isSafeInteger(totalBytes) || totalBytes > 8 * 1024 ** 3)
    throw new Error('SIZE_LIMIT')
  const disk = statfsSync(tmpdir())
  if (disk.bavail * disk.bsize < totalBytes * 1.2 + 64 * 1024 ** 2)
    throw new Error('INSUFFICIENT_SPACE')

  // The destination is ALWAYS an OS-generated temporary directory and cannot
  // be chosen by the browser or the caller. Never start an AutoFlow server on it.
  temporary = mkdtempSync(join(sandboxParent, 'restoration-'))
  const destination = join(temporary, 'isolated-restoration')
  restoreBackup(directory, destination)
  const databaseFile = join(destination, 'autoflow.db')
  const digest = createHash('sha256').update(readFileSync(databaseFile)).digest('hex')
  if (digest !== manifest.database.sha256) throw new Error('RESTORED_DB_MISMATCH')
  const db = new DatabaseSync(databaseFile, { readOnly: true })
  let orgCount, vehicleCount, accountCount
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()
    if (integrity?.integrity_check !== 'ok') throw new Error('SQLITE_FAILED')
    orgCount = db.prepare('SELECT COUNT(*) total FROM organizations').get().total
    vehicleCount = db.prepare('SELECT COUNT(*) total FROM vehicles').get().total
    accountCount = db.prepare('SELECT COUNT(*) total FROM users').get().total
    if (![orgCount, vehicleCount, accountCount].every(Number.isSafeInteger))
      throw new Error('INVALID_SCHEMA')
  } finally {
    db.close()
  }
  const imageCount = readdirSync(join(destination, 'uploads')).length
  if (imageCount !== manifest.uploads.length) throw new Error('RESTORED_UPLOADS_MISMATCH')
  response = {
    ok: true,
    createdAt: manifest.createdAt,
    databaseBytes: manifest.database.bytes,
    imageCount,
    vaultIncluded: Boolean(manifest.vault),
    organizationCount: orgCount,
    vehicleCount,
    accountCount,
    // A restored SQLite file is not proof that the AutoFlow application
    // starts, that the Facebook extension works, or that foreign DPAPI can decrypt.
    restoredFiles: true,
    databaseOpened: true,
    applicationStarted: false,
    dpapiValidated: false,
  }
} catch (error) {
  const code = error instanceof Error ? error.message : ''
  const reason = code === 'SIZE_LIMIT'
    ? 'A cópia excede o limite de 8 GB do teste isolado.'
    : code === 'INSUFFICIENT_SPACE'
      ? 'O disco temporário não possui espaço suficiente para a restauração isolada.'
      : 'Não foi possível restaurar e validar a cópia em ambiente isolado.'
  response = { ok: false, error: reason }
} finally {
  if (temporary) {
    try {
      rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Never claim success if sensitive restored bytes remain in the temp dir.
      response = {
        ok: false,
        error: 'Falha ao remover os arquivos temporários. Solicite revisão da pasta temporária do sistema.',
      }
    }
  }
}
process.stdout.write(JSON.stringify(response))
if (!response.ok) process.exitCode = 1
