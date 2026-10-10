import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initializeCredentialVault,
  encryptCredential,
  decryptCredential,
  createPortableRecoveryPackage,
  verifyPortableRecoveryPackage,
  restorePortableRecoveryPackage,
} from '../server/services/credential-vault.ts'

const root = mkdtempSync(join(tmpdir(), 'autoflow-recovery-test-'))
const initialKey = process.env.AUTOFLOW_VAULT_KEY
const initialSecret = process.env.AUTH_SECRET
try {
  process.env.AUTOFLOW_VAULT_KEY = 'offline-recovery-test-master-secret-minimum-length'
  const db = new DatabaseSync(join(root, 'autoflow.db'))
  try {
    db.exec(
      "CREATE TABLE organization_settings (organization_id INTEGER PRIMARY KEY,gemini_api_key TEXT NOT NULL DEFAULT '',openai_api_key TEXT NOT NULL DEFAULT '',alert_telegram_token TEXT NOT NULL DEFAULT '',alert_telegram_chat_id TEXT NOT NULL DEFAULT '',alert_webhook_url TEXT NOT NULL DEFAULT '')",
    )
    initializeCredentialVault(root)
    const credential = 'fake-test-gemini-credential'
    const encrypted = encryptCredential(credential, 1, 'gemini_api_key')
    db.prepare('INSERT INTO organization_settings (organization_id,gemini_api_key,openai_api_key) VALUES(1,?,?)').run(encrypted, '')
    const password = 'correct horse battery safe repository 2026'
    const exported = createPortableRecoveryPackage(db, root, password)
    assert(!exported.includes(credential), 'Recovery package must not expose credentials')
    assert(!exported.includes(encrypted), 'Recovery package must not copy ciphertext from database')
    assert.equal(verifyPortableRecoveryPackage(exported, password), true)
    assert.throws(
      () => verifyPortableRecoveryPackage(exported, 'different password length 2026'),
      /Senha de recuperação incorreta|arquivo adulterado/,
    )
    assert.throws(() => createPortableRecoveryPackage(db, root, 'weak'), /pelo menos 16/)
    const modified = JSON.parse(exported)
    modified.tag = modified.tag.slice(0, -1) + (modified.tag.endsWith('A') ? 'B' : 'A')
    assert.throws(
      () => verifyPortableRecoveryPackage(JSON.stringify(modified), password),
      /Senha de recuperação incorreta|arquivo adulterado|Arquivo de recuperação inválido/,
    )
    assert.throws(
      () => verifyPortableRecoveryPackage('{"version":999}', password),
      /Versão de recuperação incompatível/,
    )
    assert.equal(decryptCredential(encrypted, 1, 'gemini_api_key'), credential)
    // Recovery also works for an installation configured only for alert integrations.
    db.prepare("UPDATE organization_settings SET gemini_api_key='',alert_telegram_token=? WHERE organization_id=1")
      .run(encryptCredential('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', 1, 'alert_telegram_token'))
    const alertOnlyExport = createPortableRecoveryPackage(db, root, password)
    assert.equal(verifyPortableRecoveryPackage(alertOnlyExport, password), true)
    if (process.platform !== 'win32') {
      assert.throws(() => restorePortableRecoveryPackage(db, root, exported, password), /Windows/)
    }
    console.log(
      '✓ Password-wrapped recovery: no plaintext, correct/wrong password, tampering and platform guard',
    )
  } finally {
    db.close()
  }
} finally {
  if (initialKey === undefined) delete process.env.AUTOFLOW_VAULT_KEY
  else process.env.AUTOFLOW_VAULT_KEY = initialKey
  if (initialSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = initialSecret
  rmSync(root, { recursive: true, force: true })
}
