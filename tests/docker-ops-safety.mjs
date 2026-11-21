import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createBackup } from '../scripts/backup.mjs'

const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), 'autoflow-rotate-'))
try {
  const scripts = join(temp, 'scripts')
  const data = join(temp, 'data')
  const backups = join(temp, 'backups')
  mkdirSync(scripts)
  mkdirSync(data)
  mkdirSync(join(data, 'uploads'))
  copyFileSync(
    join(repository, 'scripts', 'rotate-auth-secret.mjs'),
    join(scripts, 'rotate-auth-secret.mjs'),
  )
  copyFileSync(join(repository, 'scripts', 'backup.mjs'), join(scripts, 'backup.mjs'))
  const original = randomBytes(48).toString('base64url')
  const envPath = join(temp, '.env')
  writeFileSync(envPath, 'AUTH_SECRET=' + original + '\nPUBLIC_ORIGIN=http://localhost:3333\n')
  writeFileSync(
    join(data, 'vault-key.json'),
    JSON.stringify({
      version: 1,
      mode: 'passphrase',
      salt: randomBytes(16).toString('base64'),
    }) + '\n',
  )
  const db = new DatabaseSync(join(data, 'autoflow.db'))
  db.exec(
    'CREATE TABLE organization_settings (' +
      'organization_id INTEGER, gemini_api_key TEXT, openai_api_key TEXT, ' +
      'alert_telegram_token TEXT, alert_telegram_chat_id TEXT, alert_webhook_url TEXT)',
  )
  db.close()
  await createBackup(data, backups)

  const run = (flag) =>
    spawnSync(process.execPath, [join(scripts, 'rotate-auth-secret.mjs'), flag], {
      cwd: temp,
      encoding: 'utf8',
      timeout: 10000,
    })
  let result = run('--check')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /nenhum registro criptografado/)
  result = run('--apply')
  assert.equal(result.status, 0, result.stderr)
  const newEnv = readFileSync(envPath, 'utf8')
  const next = newEnv.match(/^AUTH_SECRET=([^\n]+)/m)?.[1]
  assert.ok(next && next.length >= 32 && next !== original)
  assert.ok(!result.stdout.includes(next), 'Novo segredo nao pode aparecer nos logs')

  const writeDb = new DatabaseSync(join(data, 'autoflow.db'))
  writeDb
    .prepare('INSERT INTO organization_settings (organization_id, gemini_api_key) VALUES (?, ?)')
    .run(1, 'enc:v1:exemplo-de-credencial-que-deve-bloquear')
  writeDb.close()
  result = run('--check')
  assert.notEqual(result.status, 0, 'A verificacao deveria bloquear banco cifrado')
  assert.match(result.stderr, /criptografadas/)
  result = run('--apply')
  assert.notEqual(result.status, 0, 'A rotacao deveria bloquear banco cifrado')
  assert.equal(readFileSync(envPath, 'utf8'), newEnv, 'Nenhuma alteracao em caso de bloqueio')
  console.log('OK: troca de chave protegida contra cofre cifrado e sem segredos nos logs.')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
