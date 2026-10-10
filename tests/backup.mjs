import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createBackup, restoreBackup, verifyBackup } from '../scripts/backup.mjs'

const root = mkdtempSync(join(tmpdir(), 'autoflow-backup-test-'))
try {
  const source = join(root, 'source')
  const backupRoot = join(root, 'backups')
  const restored = join(root, 'restored')
  mkdirSync(join(source, 'uploads'), { recursive: true })
  const imageName = '0123456789abcdef01234567.jpg'
  writeFileSync(join(source, 'uploads', imageName), Buffer.from('vehicle image bytes'))
  const database = new DatabaseSync(join(source, 'autoflow.db'))
  database.exec(`CREATE TABLE organization_settings (organization_id INTEGER PRIMARY KEY, gemini_api_key TEXT NOT NULL DEFAULT '', openai_api_key TEXT NOT NULL DEFAULT '');
    CREATE TABLE vehicles (id INTEGER PRIMARY KEY, model TEXT NOT NULL);
    CREATE TABLE vehicle_images (id INTEGER PRIMARY KEY, file_name TEXT NOT NULL);
    CREATE TABLE publication_jobs (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE publication_job_events (id INTEGER PRIMARY KEY, event_type TEXT NOT NULL);`)
  database.prepare('INSERT INTO vehicles VALUES (1, ?)').run('Corolla')
  database.prepare('INSERT INTO organization_settings VALUES (1,?,?)').run('enc:v1:test-tagged-secret', '')
  database.prepare('INSERT INTO vehicle_images VALUES (1, ?)').run(imageName)
  database.prepare('INSERT INTO publication_jobs VALUES (1, ?)').run('completed')
  database.prepare('INSERT INTO publication_job_events VALUES (1, ?)').run('published')
  database.close()
  // Vault is mandatory whenever an encrypted credential exists.
  await assert.rejects(createBackup(source, backupRoot), /não inclui o cofre/)
  const vaultContents = '{"version":1,"mode":"passphrase","salt":"1234567890abcdef"}'
  writeFileSync(join(source, 'vault-key.json'), vaultContents)

  const backupDirectory = await createBackup(source, backupRoot)
  const manifest = verifyBackup(backupDirectory)
  assert.equal(manifest.uploads.length, 1)
  assert.equal(manifest.formatVersion, 2)
  assert(manifest.vault)
  assert.equal(readFileSync(join(backupDirectory,'vault-key.json'),'utf8'), vaultContents)
  restoreBackup(backupDirectory, restored)
  assert.equal(readFileSync(join(restored,'vault-key.json'),'utf8'),vaultContents)
  const restoredDb = new DatabaseSync(join(restored, 'autoflow.db'), { readOnly: true })
  assert.equal(restoredDb.prepare('SELECT model FROM vehicles WHERE id=1').get().model, 'Corolla')
  assert.equal(
    restoredDb.prepare('SELECT status FROM publication_jobs WHERE id=1').get().status,
    'completed',
  )
  assert.equal(
    restoredDb.prepare('SELECT event_type FROM publication_job_events WHERE id=1').get().event_type,
    'published',
  )
  restoredDb.close()
  assert.deepEqual(
    readFileSync(join(restored, 'uploads', imageName)),
    Buffer.from('vehicle image bytes'),
  )

  writeFileSync(join(backupDirectory, 'uploads', imageName), 'tampered')
  assert.throws(() => verifyBackup(backupDirectory), /não correspondem ao manifesto/)
  console.log('OK: snapshot SQLite, manifesto, uploads, restauração e detecção de corrupção.')
} finally {
  rmSync(root, { recursive: true, force: true })
}
