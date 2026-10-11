import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer as createSocketServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createReadStream, mkdtempSync, readdirSync, rmSync, statfsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { restoreBackup, verifyBackup } from './backup.mjs'

const appEntry = fileURLToPath(new URL('../server/server.ts', import.meta.url))
const appCwd = dirname(dirname(appEntry))

async function reserveLoopbackPort() {
  const server = createSocketServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (!address || typeof address === 'string') throw new Error('PORT')
  return address.port
}

async function verifySafeBoot(directory) {
  const port = await reserveLoopbackPort()
  const challenge = randomBytes(32).toString('hex')
  const child = spawn(process.execPath, [appEntry], {
    cwd: appCwd,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      PATH: process.env.PATH || '',
      Path: process.env.Path || '',
      SystemRoot: process.env.SystemRoot || '',
      TEMP: process.env.TEMP || '',
      TMP: process.env.TMP || '',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: directory,
      AUTH_SECRET: randomBytes(48).toString('hex'),
      AUTOFLOW_RESTORE_BOOT_PROBE: '1',
      AUTOFLOW_RESTORE_BOOT_NONCE: challenge,
      // No original login, provider, Google, Facebook or webhook secrets.
    },
  })
  let exited = false
  const exit = new Promise((resolve) =>
    child.once('exit', (code) => {
      exited = true
      resolve(code)
    }),
  )
  try {
    const deadline = Date.now() + 20000
    let lastError = null
    while (Date.now() < deadline) {
      if (exited) throw new Error('PROBE_DID_NOT_START')
      try {
        const address = 'http://127.0.0.1:' + port
        const response = await fetch(address + '/health/ready', {
          headers: { 'x-autoflow-restore-probe': challenge },
          signal: AbortSignal.timeout(1600),
        })
        if (response.status === 503) throw new Error('PROBE_NOT_READY')
        const result = await response.json()
        if (
          !response.ok ||
          result.mode !== 'restored_readonly_boot_probe' ||
          result.databaseReadOnly !== true ||
          result.workersStarted !== false ||
          result.externalIntegrationsTested !== false
        ) {
          throw new Error('PROBE_UNSAFE_RESULT')
        }
        // Auth/write routes must remain unreachable, even with the challenge.
        const denied = await fetch(address + '/api/ai/autopilot/run', {
          method: 'POST',
          headers: { 'x-autoflow-restore-probe': challenge },
          signal: AbortSignal.timeout(1600),
        })
        if (denied.status !== 404) throw new Error('PROBE_WRITE_ROUTE_ACCESSIBLE')
        const protectedProbe = await fetch(address + '/health/ready', {
          signal: AbortSignal.timeout(1600),
        })
        if (protectedProbe.status !== 403) throw new Error('PROBE_PUBLICLY_ACCESSIBLE')
        return true
      } catch (error) {
        lastError = error
        if (
          error instanceof Error &&
          /PROBE_(?:UNSAFE_RESULT|WRITE_ROUTE_ACCESSIBLE|PUBLICLY_ACCESSIBLE)/.test(error.message)
        )
          throw error
        await new Promise((resolve) => setTimeout(resolve, 180))
      }
    }
    throw lastError || new Error('PROBE_TIMEOUT')
  } finally {
    if (!exited) child.kill()
    // Wait until the server process is stopped before deleting the restored DB.
    let shutdownTimer
    try {
      await Promise.race([
        exit,
        new Promise((_, reject) => {
          shutdownTimer = setTimeout(() => reject(new Error('PROBE_SHUTDOWN_TIMEOUT')), 5000)
        }),
      ])
    } finally {
      clearTimeout(shutdownTimer)
    }
  }
}

const directory = process.argv[2]
const sandboxParent = process.argv[3]
let temporary = null
let response
try {
  if (!directory || !sandboxParent || process.argv.length !== 4) throw new Error('INVALID_BACKUP')
  // Validate the input first, before allocating staging space or copying a file.
  const manifest = verifyBackup(directory)
  const totalBytes =
    manifest.database.bytes +
    manifest.uploads.reduce((sum, item) => sum + item.bytes, 0) +
    (manifest.vault?.bytes || 0)
  if (!Number.isSafeInteger(totalBytes) || totalBytes > 8 * 1024 ** 3) throw new Error('SIZE_LIMIT')
  const disk = statfsSync(tmpdir())
  if (disk.bavail * disk.bsize < totalBytes * 1.2 + 64 * 1024 ** 2)
    throw new Error('INSUFFICIENT_SPACE')

  // The destination is ALWAYS an OS-generated temporary directory and cannot
  // be chosen by the browser or the caller. Never start an AutoFlow server on it.
  temporary = mkdtempSync(join(sandboxParent, 'restoration-'))
  const destination = join(temporary, 'isolated-restoration')
  restoreBackup(directory, destination)
  const databaseFile = join(destination, 'autoflow.db')
  // Stream large SQLite snapshots instead of holding the database in RAM.
  const hash = createHash('sha256')
  for await (const block of createReadStream(databaseFile)) hash.update(block)
  const digest = hash.digest('hex')
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
  const bootProbePassed = await verifySafeBoot(destination)
  // Ensure read-only probe did not mutate the restored database.
  const after = createHash('sha256')
  for await (const block of createReadStream(databaseFile)) after.update(block)
  if (after.digest('hex') !== digest) throw new Error('PROBE_CHANGED_DATABASE')
  response = {
    bootProbePassed,
    probeDatabaseReadOnly: true,
    backgroundWorkersStarted: false,
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
  const reason =
    code === 'SIZE_LIMIT'
      ? 'A cópia excede o limite de 8 GB do teste isolado.'
      : code === 'INSUFFICIENT_SPACE'
        ? 'O disco temporário não possui espaço suficiente para a restauração isolada.'
        : /^PROBE_[A-Z_]+$/.test(code)
          ? 'Falha na inicialização restrita: ' + code
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
        error:
          'Falha ao remover os arquivos temporários. Solicite revisão da pasta temporária do sistema.',
      }
    }
  }
}
process.stdout.write(JSON.stringify(response))
if (!response.ok) process.exitCode = 1
