import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initializeCredentialVault,
  encryptCredential,
  decryptCredential,
  createPortableRecoveryPackage,
  restorePortableRecoveryPackage,
} from '../server/services/credential-vault.ts'

if (process.platform !== 'win32') {
  console.log('SKIP Windows recovery integration')
} else {
  const root = mkdtempSync(join(tmpdir(), 'autoflow-recovery-win-'))
  const source = join(root, 'source')
  const target = join(root, 'target')
  mkdirSync(source)
  mkdirSync(target)
  const db = new DatabaseSync(join(root, 'autoflow.db'))
  try {
    db.exec(
      "CREATE TABLE organization_settings(organization_id INTEGER PRIMARY KEY,gemini_api_key TEXT NOT NULL DEFAULT '',openai_api_key TEXT NOT NULL DEFAULT '',alert_telegram_token TEXT NOT NULL DEFAULT '',alert_telegram_chat_id TEXT NOT NULL DEFAULT '',alert_webhook_url TEXT NOT NULL DEFAULT '')",
    )
    initializeCredentialVault(source)
    const encrypted = encryptCredential('example-credential-not-real', 7, 'gemini_api_key')
    db.prepare('INSERT INTO organization_settings (organization_id,gemini_api_key,openai_api_key) VALUES (7,?,?)').run(encrypted, '')
    const password = 'long-portable-recovery-password-2026'
    const bundle = createPortableRecoveryPackage(db, source, password)

    const vaultFile = join(target, 'vault-key.json')
    const oldContents = JSON.stringify({
      version: 1,
      mode: 'dpapi',
      wrappedKey: Buffer.alloc(80, 123).toString('base64'),
    })
    writeFileSync(vaultFile, oldContents)
    assert.throws(
      () =>
        restorePortableRecoveryPackage(db, target, bundle, 'wrong-password-with-many-characters'),
      /Senha de recuperação incorreta/,
    )
    assert.equal(readFileSync(vaultFile, 'utf8'), oldContents)

    const restored = restorePortableRecoveryPackage(db, target, bundle, password)
    assert.equal(restored.verifiedCredentials, 1)
    assert.equal(readFileSync(restored.previousVaultFile, 'utf8'), oldContents)
    initializeCredentialVault(target)
    assert.equal(decryptCredential(encrypted, 7, 'gemini_api_key'), 'example-credential-not-real')
    console.log('✓ Windows DPAPI portable rewrap and wrong-password integrity')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}
