import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const nameFormat = /^autoflow-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/
const workerFile = fileURLToPath(new URL('../../scripts/verify-backup-worker.mjs', import.meta.url))
const restoreWorker = fileURLToPath(
  new URL('../../scripts/restore-drill-worker.mjs', import.meta.url),
)
let verificationBusy = false

export type ListedBackup = {
  id: string
  createdAt: string
}

/** Fixed server-owned backup directory. Never use a URL-supplied absolute path. */
export function backupRoot(): string {
  return resolve(process.env.AUTOFLOW_BACKUP_ROOT || 'backups')
}

function safeRoot(): string | null {
  const root = backupRoot()
  try {
    if (!lstatSync(root).isDirectory()) return null
    return realpathSync(root)
  } catch {
    return null
  }
}

function selectedBackup(id: string): string | null {
  if (!nameFormat.test(id)) return null
  const root = safeRoot()
  if (!root) return null
  const path = join(root, id)
  try {
    // No symlinks at the selected directory or its immediate data entries.
    if (!lstatSync(path).isDirectory()) return null
    if (realpathSync(path) !== resolve(path)) return null
    for (const entry of ['manifest.json', 'autoflow.db', 'uploads']) {
      const stat = lstatSync(join(path, entry))
      if (entry === 'uploads' ? !stat.isDirectory() : !stat.isFile()) return null
    }
    const vaultPath = join(path, 'vault-key.json')
    try {
      if (!lstatSync(vaultPath).isFile()) return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    // Reject symlinked file entries, regardless of whether a manifest refers to them.
    for (const entry of readdirSync(join(path, 'uploads'), { withFileTypes: true }))
      if (!entry.isFile()) return null
    if (!path.startsWith(root + sep)) return null
    return path
  } catch {
    return null
  }
}

export function listLocalBackups(): { available: boolean; backups: ListedBackup[] } {
  const root = safeRoot()
  if (!root) return { available: false, backups: [] }
  const backups = readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory() && nameFormat.test(item.name))
    .map((item) => item.name)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 30)
    .filter((name) => Boolean(selectedBackup(name)))
    .map((id) => ({
      id,
      createdAt: id
        .slice('autoflow-backup-'.length)
        .replace(/^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/, '$1T$2:$3:$4'),
    }))
  return { available: true, backups }
}

export type BackupCheck = {
  id: string
  verifiedAt: string
  createdAt: string
  databaseBytes: number
  imageCount: number
  vaultIncluded: boolean
  integrity: 'verified'
  restoreTested: false
}

export type VerificationResult =
  { ok: true; result: BackupCheck } | { ok: false; status: number; error: string }

export async function verifyLocalBackup(id: string): Promise<VerificationResult> {
  const selected = selectedBackup(id)
  if (!selected) {
    return { ok: false, status: 400, error: 'Cópia não encontrada ou contém itens não permitidos.' }
  }
  if (verificationBusy) {
    return { ok: false, status: 409, error: 'Outra verificação já está em andamento.' }
  }
  verificationBusy = true
  try {
    return await new Promise<VerificationResult>((done) => {
      const child = spawn(process.execPath, [workerFile, selected], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        // No app credentials are needed to validate hashes and the SQLite snapshot.
        env: {
          PATH: process.env.PATH || '',
          Path: process.env.Path || '',
          SystemRoot: process.env.SystemRoot || '',
          TEMP: process.env.TEMP || '',
          TMP: process.env.TMP || '',
        },
      })
      let output = ''
      let finished = false
      const finish = (value: VerificationResult) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        done(value)
      }
      const timeout = setTimeout(() => {
        child.kill()
        finish({
          ok: false,
          status: 504,
          error: 'Verificação excedeu dois minutos. A cópia não foi alterada.',
        })
      }, 120_000)
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > 8192) {
          child.kill()
          finish({ ok: false, status: 502, error: 'Resposta do verificador excedeu o limite.' })
        }
      })
      child.on('error', () =>
        finish({
          ok: false,
          status: 502,
          error: 'Não foi possível iniciar a verificação isolada.',
        }),
      )
      child.on('close', (code) => {
        if (finished) return
        try {
          const payload = JSON.parse(output) as Record<string, unknown>
          if (
            code === 0 &&
            payload.ok === true &&
            Number.isSafeInteger(payload.databaseBytes) &&
            Number.isSafeInteger(payload.imageCount) &&
            typeof payload.createdAt === 'string'
          ) {
            finish({
              ok: true,
              result: {
                id,
                verifiedAt: new Date().toISOString(),
                createdAt: payload.createdAt,
                databaseBytes: payload.databaseBytes as number,
                imageCount: payload.imageCount as number,
                vaultIncluded: payload.vaultIncluded === true,
                integrity: 'verified',
                restoreTested: false,
              },
            })
          } else {
            finish({
              ok: false,
              status: 422,
              error:
                typeof payload.error === 'string'
                  ? payload.error.slice(0, 180)
                  : 'A cópia não passou na verificação de integridade.',
            })
          }
        } catch {
          finish({
            ok: false,
            status: 502,
            error: 'O verificador não retornou uma resposta válida.',
          })
        }
      })
    })
  } finally {
    verificationBusy = false
  }
}

export type RestoreDrill = {
  id: string
  testedAt: string
  createdAt: string
  databaseBytes: number
  imageCount: number
  vaultIncluded: boolean
  organizationCount: number
  vehicleCount: number
  accountCount: number
  restoredFiles: true
  databaseOpened: true
  applicationStarted: false
  bootProbePassed: true
  probeDatabaseReadOnly: true
  backgroundWorkersStarted: false
  dpapiValidated: false
  temporaryRemoved: true
}

export type RestoreDrillResult =
  { ok: true; result: RestoreDrill } | { ok: false; status: number; error: string }

/**
 * Always isolates restored bytes in an OS-generated sandbox, which is owned
 * by the parent process. Parent cleanup also runs when a worker times out.
 * Shares the verifier's busy flag to avoid overlapping costly disk operations.
 */
export async function runIsolatedRestoreDrill(id: string): Promise<RestoreDrillResult> {
  const selected = selectedBackup(id)
  if (!selected) {
    return { ok: false, status: 400, error: 'Cópia não encontrada ou contém itens não permitidos.' }
  }
  if (verificationBusy) {
    return { ok: false, status: 409, error: 'Já existe uma operação de backup em andamento.' }
  }
  verificationBusy = true
  let sandbox: string | null = null
  try {
    sandbox = mkdtempSync(join(tmpdir(), 'autoflow-restore-check-'))
    const tempPath = sandbox
    return await new Promise<RestoreDrillResult>((done) => {
      const child = spawn(process.execPath, [restoreWorker, selected, tempPath], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          PATH: process.env.PATH || '',
          Path: process.env.Path || '',
          SystemRoot: process.env.SystemRoot || '',
          TEMP: process.env.TEMP || '',
          TMP: process.env.TMP || '',
        },
      })
      let output = ''
      let timedOut = false
      let oversized = false
      let launchError = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, 180_000)
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > 8192) {
          oversized = true
          child.kill()
        }
      })
      child.on('error', () => {
        launchError = true
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        let cleaned = false
        try {
          rmSync(tempPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
          cleaned = true
          sandbox = null
        } catch {
          // Never return success if the restored database might be left on disk.
        }
        if (!cleaned) {
          done({ ok: false, status: 500, error: 'Falha ao limpar a área temporária do teste.' })
          return
        }
        if (timedOut) {
          done({
            ok: false,
            status: 504,
            error: 'Teste excedeu três minutos; diretório temporário removido.',
          })
          return
        }
        if (oversized || launchError) {
          done({ ok: false, status: 502, error: 'Falha no processo isolado de restauração.' })
          return
        }
        try {
          const payload = JSON.parse(output) as Record<string, unknown>
          if (
            code === 0 &&
            payload.ok === true &&
            payload.restoredFiles === true &&
            payload.databaseOpened === true &&
            payload.applicationStarted === false &&
            payload.bootProbePassed === true &&
            payload.probeDatabaseReadOnly === true &&
            payload.backgroundWorkersStarted === false &&
            payload.dpapiValidated === false &&
            Number.isSafeInteger(payload.databaseBytes) &&
            Number.isSafeInteger(payload.imageCount) &&
            Number.isSafeInteger(payload.organizationCount) &&
            Number.isSafeInteger(payload.vehicleCount) &&
            Number.isSafeInteger(payload.accountCount) &&
            typeof payload.createdAt === 'string'
          ) {
            done({
              ok: true,
              result: {
                id,
                testedAt: new Date().toISOString(),
                createdAt: payload.createdAt,
                databaseBytes: payload.databaseBytes as number,
                imageCount: payload.imageCount as number,
                organizationCount: payload.organizationCount as number,
                vehicleCount: payload.vehicleCount as number,
                accountCount: payload.accountCount as number,
                vaultIncluded: payload.vaultIncluded === true,
                restoredFiles: true,
                databaseOpened: true,
                applicationStarted: false,
                bootProbePassed: true,
                probeDatabaseReadOnly: true,
                backgroundWorkersStarted: false,
                dpapiValidated: false,
                temporaryRemoved: true,
              },
            })
          } else {
            done({
              ok: false,
              status: 422,
              error:
                typeof payload.error === 'string'
                  ? payload.error.slice(0, 180)
                  : 'O ensaio isolado de restauração falhou.',
            })
          }
        } catch {
          done({ ok: false, status: 502, error: 'Resposta inválida do ensaio isolado.' })
        }
      })
    })
  } catch {
    return { ok: false, status: 500, error: 'Não foi possível preparar o ambiente temporário.' }
  } finally {
    if (sandbox) {
      try {
        rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        // The worker never receives the production DATA_DIR.
      }
    }
    verificationBusy = false
  }
}
