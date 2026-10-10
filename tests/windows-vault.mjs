import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  initializeCredentialVault,
  encryptCredential,
  decryptCredential,
  migrateCredentials,
} from '../server/services/credential-vault.ts'

if (process.platform !== 'win32') {
  console.log('SKIP: Windows DPAPI integration requires a real Windows process')
} else {
  const root = mkdtempSync(join(tmpdir(), 'autoflow-windows-dpapi-'))
  const db = new DatabaseSync(join(root, 'test.db'))
  try {
    initializeCredentialVault(root)
    const vaultFile = JSON.parse(readFileSync(join(root, 'vault-key.json'), 'utf8'))
    assert.equal(vaultFile.mode, 'dpapi')
    assert(!JSON.stringify(vaultFile).includes('test-fake-gemini'))
    const encrypted = encryptCredential('test-fake-gemini', 7, 'gemini_api_key')
    assert(encrypted.startsWith('enc:v1:'))
    assert(!encrypted.includes('test-fake-gemini'))
    assert.equal(decryptCredential(encrypted, 7, 'gemini_api_key'), 'test-fake-gemini')
    assert.throws(() => decryptCredential(encrypted, 8, 'gemini_api_key'))

    // Force a second DPAPI unprotect using the actual file, not cached test state.
    initializeCredentialVault(root)
    assert.equal(decryptCredential(encrypted, 7, 'gemini_api_key'), 'test-fake-gemini')

    db.exec(
      "CREATE TABLE organization_settings (organization_id INTEGER PRIMARY KEY,gemini_api_key TEXT NOT NULL DEFAULT '',openai_api_key TEXT NOT NULL DEFAULT '',alert_telegram_token TEXT NOT NULL DEFAULT '',alert_telegram_chat_id TEXT NOT NULL DEFAULT '',alert_webhook_url TEXT NOT NULL DEFAULT '')",
    )
    db.prepare(
      'INSERT INTO organization_settings (organization_id,gemini_api_key,openai_api_key) VALUES(7,?,?)',
    ).run('legacy-gemini-fake-key', 'legacy-openai-fake-key')
    migrateCredentials(db)
    const row = db
      .prepare(
        'SELECT gemini_api_key gemini,openai_api_key openai FROM organization_settings WHERE organization_id=7',
      )
      .get()
    assert(row.gemini.startsWith('enc:v1:') && row.openai.startsWith('enc:v1:'))
    assert.equal(decryptCredential(row.gemini, 7, 'gemini_api_key'), 'legacy-gemini-fake-key')
    assert.equal(decryptCredential(row.openai, 7, 'openai_api_key'), 'legacy-openai-fake-key')
    initializeCredentialVault(root)
    migrateCredentials(db)
    const same = db
      .prepare(
        'SELECT gemini_api_key gemini,openai_api_key openai FROM organization_settings WHERE organization_id=7',
      )
      .get()
    assert.deepEqual(same, row, 'Restart must not rewrite encrypted credentials')
    console.log('✓ Windows DPAPI protect/unprotect, encrypted credential migration and restart')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}
