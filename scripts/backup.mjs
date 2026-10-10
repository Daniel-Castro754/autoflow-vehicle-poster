import { createHash, randomUUID } from 'node:crypto'
import { error as logError, log } from 'node:console'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync, backup } from 'node:sqlite'
import process from 'node:process'

const DATABASE_NAME = 'autoflow.db'
const MANIFEST_NAME = 'manifest.json'
const FORMAT_VERSION = 2
const VAULT_FILE = 'vault-key.json'

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function listUploads(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile())
        throw new Error(`A pasta de uploads contém um item não suportado: ${entry.name}`)
      const path = join(directory, entry.name)
      return { name: entry.name, bytes: statSync(path).size, sha256: sha256(path) }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function validateDatabase(path, uploadNames) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const integrity = database.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('A verificação de integridade SQLite falhou.')
    }
    const imageTable = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vehicle_images'")
      .get()
    if (imageTable) {
      const missing = database.prepare('SELECT file_name FROM vehicle_images').all()
      for (const image of missing) {
        if (!uploadNames.has(image.file_name))
          throw new Error(`A imagem referenciada pelo banco não está no backup: ${image.file_name}`)
      }
    }
    const hasCredentialTable = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_settings'")
      .get()
    if (hasCredentialTable) {
      const available = new Set(
        database
          .prepare('PRAGMA table_info(organization_settings)')
          .all()
          .map((column) => column.name),
      )
      const fields = [
        'gemini_api_key',
        'openai_api_key',
        'alert_telegram_token',
        'alert_telegram_chat_id',
        'alert_webhook_url',
      ].filter((field) => available.has(field))
      const encrypted = fields.length
        ? database
            .prepare(
              'SELECT 1 FROM organization_settings WHERE ' +
                fields.map((field) => field + " LIKE 'enc:v1:%'").join(' OR ') +
                ' LIMIT 1',
            )
            .get()
        : undefined
      if (encrypted && !uploadNames.has('__vault_present__')) {
        throw new Error('O banco contém chaves criptografadas, mas o backup não inclui o cofre.')
      }
    }
  } finally {
    database.close()
  }
}

export async function createBackup(dataDirectory, backupRoot) {
  const source = resolve(dataDirectory)
  const root = resolve(backupRoot)
  const databasePath = join(source, DATABASE_NAME)
  const uploadDirectory = join(source, 'uploads')
  if (!existsSync(databasePath) || !statSync(databasePath).isFile())
    throw new Error(`Banco não encontrado: ${databasePath}`)
  if (!existsSync(uploadDirectory) || !statSync(uploadDirectory).isDirectory())
    throw new Error(`Pasta de uploads não encontrada: ${uploadDirectory}`)

  mkdirSync(root, { recursive: true })
  const timestamp = new Date().toISOString().replaceAll(':', '-')
  const destination = join(root, `autoflow-backup-${timestamp}`)
  const staging = `${destination}.tmp-${randomUUID()}`
  if (existsSync(destination)) throw new Error(`O destino do backup já existe: ${destination}`)
  mkdirSync(staging)
  try {
    mkdirSync(join(staging, 'uploads'))
    const sourceDb = new DatabaseSync(databasePath, { readOnly: true })
    try {
      await backup(sourceDb, join(staging, DATABASE_NAME))
    } finally {
      sourceDb.close()
    }
    const uploads = listUploads(uploadDirectory)
    for (const file of uploads)
      copyFileSync(join(uploadDirectory, file.name), join(staging, 'uploads', file.name))
    const copiedUploads = listUploads(join(staging, 'uploads'))
    if (JSON.stringify(uploads) !== JSON.stringify(copiedUploads))
      throw new Error('Os uploads mudaram durante o backup. Pare o servidor e tente novamente.')
    const vaultPath = join(source, VAULT_FILE)
    const vault = existsSync(vaultPath)
      ? { name: VAULT_FILE, bytes: statSync(vaultPath).size, sha256: sha256(vaultPath) }
      : null
    if (vault) copyFileSync(vaultPath, join(staging, VAULT_FILE))
    validateDatabase(
      join(staging, DATABASE_NAME),
      new Set([...copiedUploads.map((file) => file.name), ...(vault ? ['__vault_present__'] : [])]),
    )
    const manifest = {
      formatVersion: FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      database: {
        name: DATABASE_NAME,
        bytes: statSync(join(staging, DATABASE_NAME)).size,
        sha256: sha256(join(staging, DATABASE_NAME)),
      },
      uploads: copiedUploads,
      vault,
    }
    writeFileSync(join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
    })
    renameSync(staging, destination)
    return destination
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

export function verifyBackup(backupDirectory) {
  const source = resolve(backupDirectory)
  const manifestPath = join(source, MANIFEST_NAME)
  if (!existsSync(manifestPath)) throw new Error('Manifesto do backup não encontrado.')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (
    ![1, FORMAT_VERSION].includes(manifest.formatVersion) ||
    manifest.database?.name !== DATABASE_NAME ||
    !Array.isArray(manifest.uploads)
  ) {
    throw new Error('Formato do manifesto de backup não suportado.')
  }
  const databasePath = join(source, DATABASE_NAME)
  if (
    !existsSync(databasePath) ||
    statSync(databasePath).size !== manifest.database.bytes ||
    sha256(databasePath) !== manifest.database.sha256
  ) {
    throw new Error('O banco do backup está ausente ou não corresponde ao manifesto.')
  }
  const uploads = listUploads(join(source, 'uploads'))
  if (JSON.stringify(uploads) !== JSON.stringify(manifest.uploads))
    throw new Error('Os uploads do backup estão ausentes ou não correspondem ao manifesto.')
  const vault = manifest.formatVersion === FORMAT_VERSION ? manifest.vault : null
  if (vault) {
    const vaultPath = join(source, VAULT_FILE)
    if (
      vault.name !== VAULT_FILE ||
      !existsSync(vaultPath) ||
      statSync(vaultPath).size !== vault.bytes ||
      sha256(vaultPath) !== vault.sha256
    ) {
      throw new Error('O cofre do backup está ausente ou não corresponde ao manifesto.')
    }
  }
  validateDatabase(
    databasePath,
    new Set([...uploads.map((file) => file.name), ...(vault ? ['__vault_present__'] : [])]),
  )
  return manifest
}

export function restoreBackup(backupDirectory, destinationDirectory) {
  const manifest = verifyBackup(backupDirectory)
  const source = resolve(backupDirectory)
  const destination = resolve(destinationDirectory)
  const relativeDestination = relative(source, destination)
  if (
    source === destination ||
    (!relativeDestination.startsWith(`..${sep}`) &&
      relativeDestination !== '..' &&
      !relativeDestination.startsWith(sep))
  ) {
    throw new Error('O destino da restauração não pode ficar dentro do backup.')
  }
  if (existsSync(destination) && readdirSync(destination).length > 0)
    throw new Error('O destino da restauração precisa estar vazio.')
  const staging = `${destination}.restore-${randomUUID()}`
  try {
    mkdirSync(staging, { recursive: true })
    copyFileSync(join(source, DATABASE_NAME), join(staging, DATABASE_NAME))
    cpSync(join(source, 'uploads'), join(staging, 'uploads'), { recursive: true })
    if (manifest.vault) copyFileSync(join(source, VAULT_FILE), join(staging, VAULT_FILE))
    validateDatabase(
      join(staging, DATABASE_NAME),
      new Set([
        ...manifest.uploads.map((file) => file.name),
        ...(manifest.vault ? ['__vault_present__'] : []),
      ]),
    )
    if (existsSync(destination)) rmdirSync(destination)
    renameSync(staging, destination)
    return destination
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

async function main(args) {
  const [command, ...values] = args
  if (command === 'create' && values.length === 1) {
    const dataDirectory = resolve(process.env.DATA_DIR || 'data')
    const output = await createBackup(dataDirectory, values[0])
    log(`Backup criado e verificado: ${output}`)
    return
  }
  if (command === 'verify' && values.length === 1) {
    const manifest = verifyBackup(values[0])
    log(
      `Backup íntegro: ${manifest.database.bytes} bytes, ${manifest.uploads.length} arquivo(s) de imagem.`,
    )
    return
  }
  if (command === 'restore' && values.length === 2) {
    const output = restoreBackup(values[0], values[1])
    log(`Backup restaurado: ${output}`)
    return
  }
  throw new Error(
    'Uso: node scripts/backup.mjs create <pasta-backups> | verify <backup> | restore <backup> <destino-vazio>',
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    logError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
