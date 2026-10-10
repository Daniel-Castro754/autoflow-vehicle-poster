import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackup } from '../scripts/backup.mjs'
import { startTestServer, createApiClient } from './helpers/server.mjs'

const backupRoot = mkdtempSync(join(tmpdir(), 'autoflow-verified-backups-'))
const server = await startTestServer({ AUTOFLOW_BACKUP_ROOT: backupRoot })
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
try {
  const anonymous = createApiClient(server.base, '')
  const login = await anonymous('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const admin = createApiClient(server.base, login.token)
  const user = db.prepare('SELECT organization_id org,password_hash hash FROM users WHERE email=?')
    .get(server.email)
  db.prepare('INSERT INTO users(organization_id,name,email,password_hash,role) VALUES(?,?,?,?,?)')
    .run(user.org, 'Test Seller', 'backup-seller@test.local', user.hash, 'seller')
  const sellerLogin = await anonymous('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'backup-seller@test.local', password: server.password }),
  })
  const seller = createApiClient(server.base, sellerLogin.token)
  const verify = async (api, id) => api('/health/backups/verify', {
    method: 'POST',
    body: JSON.stringify({ backupId: id }),
  })

  await assert.rejects(anonymous('/health/backups'), (error) => error.status === 401)
  await assert.rejects(seller('/health/backups'), (error) => error.status === 403)
  await assert.rejects(verify(seller, 'no-backup'), (error) => error.status === 403)
  assert.deepEqual((await admin('/health/backups')).backups, [])

  const first = await createBackup(server.dataDir, backupRoot)
  const id = first.split(/[\\/]/).at(-1)
  const all = await admin('/health/backups')
  assert.equal(all.available, true)
  assert(all.backups.some((entry) => entry.id === id))
  assert(all.backups.every((entry) => !Object.hasOwn(entry, 'path')))
  assert(!JSON.stringify(all).includes(server.dataDir))
  const liveDb = join(server.dataDir, 'autoflow.db')
  const before = digest(liveDb)
  const savedDb = digest(join(first, 'autoflow.db'))
  const checked = await verify(admin, id)
  assert.equal(checked.integrity, 'verified')
  assert.equal(checked.restoreTested, false)
  assert.equal(checked.id, id)
  assert.equal(checked.vaultIncluded, true)
  assert.equal(checked.imageCount, 0)
  assert.equal(checked.databaseBytes > 0, true)
  assert.equal(digest(liveDb), before)
  assert.equal(digest(join(first, 'autoflow.db')), savedDb)
  assert.equal(readdirSync(join(first, 'uploads')).length, 0)

  for (const invalid of [
    '../autoflow.db', 'autoflow-backup-../../etc/passwd',
    'C:\\Windows\\System32', '/etc/passwd', 'autoflow-backup-2026-01-01T00-00-00.000Z/../',
  ]) {
    await assert.rejects(verify(admin, invalid), (error) => error.status === 400)
  }
  // Link-created backup must not be served, even with a valid-looking name.
  if (process.platform !== 'win32') {
    const alias = 'autoflow-backup-2031-01-02T03-04-05.006Z'
    symlinkSync(first, join(backupRoot, alias), 'dir')
    assert(!(await admin('/health/backups')).backups.some((entry) => entry.id === alias))
    await assert.rejects(verify(admin, alias), (error) => error.status === 400)
  }

  writeFileSync(join(first, 'autoflow.db'), Buffer.from('tampered-backup-file'))
  await assert.rejects(verify(admin, id), (error) => error.status === 422)
  assert.equal(digest(liveDb), before)

  // Global server backups contain all tenants: fail closed on multi-tenant instances.
  const foreign = Number(
    db.prepare("INSERT INTO organizations(name) VALUES('Second Organization')").run().lastInsertRowid,
  )
  db.prepare('INSERT INTO organization_settings(organization_id) VALUES(?)').run(foreign)
  await assert.rejects(admin('/health/backups'), (error) => error.status === 403)
  await assert.rejects(verify(admin, id), (error) => error.status === 403)
  console.log('✓ Backup verification: admin-only, no restore/write, symlink and traversal protection, corruption, multi-tenant denial')
} finally {
  db.close()
  await server.close()
  rmSync(backupRoot, { recursive: true, force: true })
}
