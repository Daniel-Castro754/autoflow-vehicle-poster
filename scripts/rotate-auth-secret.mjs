#!/usr/bin/env node
/**
 * Offline rotation of AUTH_SECRET for Docker Desktop installations with NO
 * encrypted credentials in the database. It deliberately refuses to rewrite
 * the existing vault or attempt risky decryption/migration.
 *
 * Usage: node scripts/rotate-auth-secret.mjs --check | --apply
 * Stop the app and create/verify a complete backup before --apply.
 */
import { randomBytes } from 'node:crypto'
import {
  existsSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { verifyBackup } from './backup.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fields = [
  'gemini_api_key', 'openai_api_key', 'alert_telegram_token',
  'alert_telegram_chat_id', 'alert_webhook_url',
]

function configuration() {
  const envPath = join(root, '.env')
  if (!existsSync(envPath)) throw new Error('Arquivo .env nao encontrado.')
  const body = readFileSync(envPath, 'utf8')
  const matches = [...body.matchAll(/^AUTH_SECRET=([^\r\n]*)/gm)]
  if (matches.length !== 1 || matches[0][1].trim().length < 32)
    throw new Error('AUTH_SECRET ausente, duplicado ou menor que 32 caracteres.')
  return { envPath, body }
}

function auditVault() {
  const data = join(root, 'data')
  const vaultPath = join(data, 'vault-key.json')
  const dbPath = join(data, 'autoflow.db')
  if (!existsSync(dbPath) || !existsSync(vaultPath))
    throw new Error('Banco ou cofre nao encontrado. Nao alterei nenhuma chave.')
  const vault = JSON.parse(readFileSync(vaultPath, 'utf8'))
  if (vault.version !== 1 || vault.mode !== 'passphrase')
    throw new Error('Este script suporta apenas o cofre passphrase do Docker Linux.')
  if (!vault.salt || Buffer.from(vault.salt, 'base64').length !== 16)
    throw new Error('Sal do cofre invalido. Nada foi modificado.')

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const existing = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='organization_settings'",
    ).get()
    if (!existing) throw new Error('Tabela de credenciais ausente.')
    const columns = new Set(
      db.prepare('PRAGMA table_info(organization_settings)').all().map((item) => item.name),
    )
    const availableFields = fields.filter((field) => columns.has(field))
    if (availableFields.length !== fields.length)
      throw new Error('Schema de credenciais desconhecido. Nao vou trocar a chave.')
    const encrypted = db.prepare(
      'SELECT COUNT(*) count FROM organization_settings WHERE ' +
        availableFields.map((field) => field + " LIKE 'enc:%'").join(' OR '),
    ).get()
    return Number(encrypted.count)
  } finally {
    db.close()
  }
}

function verifyRecentBackup() {
  const backupRoot = join(root, 'backups')
  if (!existsSync(backupRoot)) throw new Error('Pasta backups nao encontrada.')
  const available = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^autoflow-backup-\d{4}-/.test(entry.name))
    .map((entry) => join(backupRoot, entry.name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  if (!available.length) throw new Error('Faca um backup completo antes da troca.')
  const manifest = verifyBackup(available[0])
  if (!manifest.createdAt || Date.now() - Date.parse(manifest.createdAt) > 24 * 3600 * 1000)
    throw new Error('O backup precisa ter sido criado nas ultimas 24 horas.')
}

async function serverOnline() {
  try {
    const response = await fetch('http://127.0.0.1:3333/health/live', {
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
  } catch {
    return false
  }
}

async function main() {
  if (!['--check', '--apply'].includes(process.argv[2]) || process.argv.length !== 3)
    throw new Error('Uso: node scripts/rotate-auth-secret.mjs --check | --apply')
  const { envPath, body } = configuration()
  const encrypted = auditVault()
  if (encrypted > 0) {
    throw new Error(
      'Credenciais criptografadas encontradas. Rotacao automatica bloqueada: ' +
      'requer migracao segura do cofre, sem apagar ou substituir vault-key.json.',
    )
  }
  if (process.argv[2] === '--check') {
    console.log('Rotacao permitida: nenhum registro criptografado encontrado.')
    console.log('Antes de aplicar: pare o app e crie um backup valido.')
    return
  }
  if (await serverOnline())
    throw new Error('Auto Flow ativo na porta 3333. Pare o container antes de trocar a chave.')
  verifyRecentBackup()
  const next = randomBytes(48).toString('base64url')
  const content = body.replace(/^AUTH_SECRET=[^\r\n]*/m, 'AUTH_SECRET=' + next)
  const temp = envPath + '.rotating-' + randomBytes(8).toString('hex')
  try {
    writeFileSync(temp, content, { flag: 'wx', mode: 0o600 })
    renameSync(temp, envPath)
  } finally {
    if (existsSync(temp)) rmSync(temp)
  }
  console.log('AUTH_SECRET atualizado no .env, sem exibir o valor.')
  console.log('O cofre nao foi apagado. As sessoes antigas foram invalidadas.')
  console.log('Agora recrie o container: docker compose up -d --force-recreate app')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
