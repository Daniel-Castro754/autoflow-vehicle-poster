import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'

const FILE = 'vault-key.json'
const PREFIX = 'enc:v1:'
type Field = 'gemini_api_key' | 'openai_api_key'
type VaultFile =
  | { version: 1; mode: 'dpapi'; wrappedKey: string }
  | { version: 1; mode: 'passphrase'; salt: string }
let vaultKey: Buffer | null = null

/**
 * Invoke Windows PowerShell 5.1 using UTF-16LE encoded code.
 * Explicitly load System.Security for hosts that do not load DPAPI by default.
 * Credential bytes travel exclusively on stdin, never in argv or logs.
 */
function dpapi(operation: 'Protect' | 'Unprotect', bytes: Buffer): Buffer {
  if (process.platform !== 'win32')
    throw new Error('DPAPI só está disponível no Windows.')

  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  Add-Type -AssemblyName System.Security -ErrorAction Stop',
    '  $encoded = [Console]::In.ReadToEnd().Trim()',
    '  if (-not $encoded) { throw "MissingInput" }',
    '  [byte[]] $inputBytes = [Convert]::FromBase64String($encoded)',
    '  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
    '  [byte[]] $outputBytes = [System.Security.Cryptography.ProtectedData]::' +
      operation + '($inputBytes, $null, $scope)',
    '  [Console]::Out.Write([Convert]::ToBase64String($outputBytes))',
    '} catch {',
    "  [Console]::Error.WriteLine('DPAPI_ERROR_TYPE:' + $_.Exception.GetType().Name)",
    '  exit 23',
    '}',
  ].join('\n')
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64')
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
    {
      input: bytes.toString('base64'),
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 16384,
    },
  )
  if (result.status !== 0 || result.error || !result.stdout?.trim()) {
    // Record only error type; never print stdin or a credential.
    const category = result.stderr?.match(/DPAPI_ERROR_TYPE:([A-Za-z]+)/)?.[1]
      || result.error?.code || 'exit-' + String(result.status)
    throw new Error(
      'O Windows não conseguiu ' +
      (operation === 'Protect' ? 'proteger' : 'desbloquear') +
      ' o cofre DPAPI (' + category + '). Os dados foram preservados.',
    )
  }
  const base64 = result.stdout.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    throw new Error('A saída do cofre DPAPI não está em Base64 válido.')
  const decoded = Buffer.from(base64, 'base64')
  if (!decoded.length) throw new Error('O cofre DPAPI retornou uma chave inválida.')
  return decoded
}

export function initializeCredentialVault(dataDir: string) {
  const path = join(dataDir, FILE)
  mkdirSync(dataDir, { recursive: true })
  const password = process.env.AUTOFLOW_VAULT_KEY?.trim() || process.env.AUTH_SECRET?.trim()
  let file: VaultFile
  if (existsSync(path)) {
    file = JSON.parse(readFileSync(path, 'utf8')) as VaultFile
  } else if (process.platform === 'win32') {
    // Never leave a vault file behind if either DPAPI operation fails.
    const plain = randomBytes(32)
    try {
      const wrapped = dpapi('Protect', plain)
      const unwrapped = dpapi('Unprotect', wrapped)
      try {
        if (unwrapped.length !== plain.length || !timingSafeEqual(plain, unwrapped))
          throw new Error('O cofre DPAPI falhou na verificação local de criação.')
      } finally {
        unwrapped.fill(0)
      }
      file = { version: 1, mode: 'dpapi', wrappedKey: wrapped.toString('base64') }
      writeFileSync(path, JSON.stringify(file) + '\n', { flag: 'wx', mode: 0o600 })
    } finally {
      plain.fill(0)
    }
  } else {
    if (!password || password.length < 32)
      throw new Error('Defina AUTOFLOW_VAULT_KEY ou AUTH_SECRET com pelo menos 32 caracteres.')
    file = { version: 1, mode: 'passphrase', salt: randomBytes(16).toString('base64') }
    writeFileSync(path, JSON.stringify(file) + '\n', { flag: 'wx', mode: 0o600 })
  }
  if (file.version !== 1) throw new Error('Versão de cofre de credenciais incompatível.')
  if (file.mode === 'dpapi') {
    if (process.platform !== 'win32')
      throw new Error('Este cofre é protegido pelo Windows e precisa do usuário Windows original.')
    vaultKey = dpapi('Unprotect', Buffer.from(file.wrappedKey, 'base64'))
  } else if (file.mode === 'passphrase') {
    if (!password || password.length < 32)
      throw new Error('O segredo do cofre está ausente. Restaure a configuração anterior.')
    vaultKey = scryptSync(password, Buffer.from(file.salt, 'base64'), 32)
  } else {
    throw new Error('Formato de cofre desconhecido. Nenhuma chave foi modificada.')
  }
  if (vaultKey.length !== 32) throw new Error('A chave mestre do cofre é inválida.')
}

function key() {
  if (!vaultKey) throw new Error('O cofre de credenciais ainda não foi inicializado.')
  return vaultKey
}

export function isEncryptedCredential(value: string): boolean {
  return value.startsWith(PREFIX)
}

export function encryptCredential(value: string, org: number, field: Field): string {
  if (!value) return ''
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), nonce)
  cipher.setAAD(Buffer.from(org + ':' + field))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return (
    PREFIX + [nonce, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64url')).join(':')
  )
}

export function decryptCredential(value: string, org: number, field: Field): string {
  if (!value || !isEncryptedCredential(value)) return value || ''
  try {
    const parts = value.slice(PREFIX.length).split(':')
    if (parts.length !== 3) throw new Error('bad format')
    const [iv, tag, body] = parts.map((part) => Buffer.from(part, 'base64url'))
    if (!iv || !tag || !body || iv.length !== 12 || tag.length !== 16) throw new Error('bad size')
    const decipher = createDecipheriv('aes-256-gcm', key(), iv)
    decipher.setAAD(Buffer.from(org + ':' + field))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    throw new Error(
      'Não foi possível desbloquear as credenciais. Confira o usuário Windows ou o segredo do cofre; os dados foram preservados.',
    )
  }
}

export function getAiCredentials(db: DatabaseSync, org: number) {
  const row = db
    .prepare(
      'SELECT gemini_api_key gemini,openai_api_key openai,ai_provider provider FROM organization_settings WHERE organization_id=?',
    )
    .get(org) as { gemini: string; openai: string; provider: string } | undefined
  return {
    geminiApiKey: decryptCredential(row?.gemini || '', org, 'gemini_api_key'),
    openaiApiKey: decryptCredential(row?.openai || '', org, 'openai_api_key'),
    aiProvider: row?.provider || 'auto',
  }
}

/** Run after schema migration, before opening the server. Corruption or lost keys fail closed. */
export function migrateCredentials(db: DatabaseSync) {
  const rows = db
    .prepare(
      'SELECT organization_id id,gemini_api_key gemini,openai_api_key openai FROM organization_settings',
    )
    .all() as Array<{ id: number; gemini: string; openai: string }>
  // Validate all existing ciphertext before any writes.
  for (const row of rows) {
    decryptCredential(row.gemini, row.id, 'gemini_api_key')
    decryptCredential(row.openai, row.id, 'openai_api_key')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of rows) {
      const gemini =
        row.gemini && !isEncryptedCredential(row.gemini)
          ? encryptCredential(row.gemini, row.id, 'gemini_api_key')
          : row.gemini
      const openai =
        row.openai && !isEncryptedCredential(row.openai)
          ? encryptCredential(row.openai, row.id, 'openai_api_key')
          : row.openai
      if (gemini !== row.gemini || openai !== row.openai)
        db.prepare(
          'UPDATE organization_settings SET gemini_api_key=?,openai_api_key=? WHERE organization_id=?',
        ).run(gemini, openai, row.id)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
