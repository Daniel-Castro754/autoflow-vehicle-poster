import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { startTestServer, createApiClient } from './helpers/server.mjs'
import { findBestAccountForVehicle } from '../server/modules/accounts.ts'

const server = await startTestServer()
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
db.function('autoflow_day', (value) => String(value || '').slice(0, 10))
const fail = (op, status) => assert.rejects(op, (error) => error.status === status)

try {
  const anon = createApiClient(server.base, '')
  const login = await anon('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const api = createApiClient(server.base, login.token)
  const owner = db
    .prepare('SELECT id, organization_id org FROM users WHERE email=?')
    .get(server.email)
  const accountId = Number(
    db
      .prepare(
        'INSERT INTO social_accounts (organization_id,user_id,label,browser_profile,status) ' +
          "VALUES (?,?, 'Daniel','Daniel','not_connected')",
      )
      .run(owner.org, owner.id).lastInsertRowid,
  )

  const presence = (id) =>
    api('/extension/presence', {
      method: 'POST',
      body: JSON.stringify({ accountId: id }),
    })

  await fail(
    () =>
      anon('/extension/presence', {
        method: 'POST',
        body: JSON.stringify({ accountId }),
      }),
    401,
  )
  await fail(() => presence(-1), 403)
  await fail(() => presence('1'), 403)
  await fail(() => presence(999999), 403)

  const foreignOrg = Number(
    db.prepare("INSERT INTO organizations(name) VALUES ('Fora da organização')").run()
      .lastInsertRowid,
  )
  const foreignAccount = Number(
    db
      .prepare(
        'INSERT INTO social_accounts (organization_id,user_id,label,browser_profile,status) ' +
          "VALUES (?,?, 'Outro','Outro','not_connected')",
      )
      .run(foreignOrg, owner.id).lastInsertRowid,
  )
  await fail(() => presence(foreignAccount), 403)

  // A stale profile must not receive automatically assigned new jobs.
  db.prepare(
    "UPDATE social_accounts SET status='connected',last_seen_at=datetime('now','-20 minutes') WHERE id=?",
  ).run(accountId)
  assert.equal(findBestAccountForVehicle(db, owner.org, 12345), null)
  assert.deepEqual(await presence(accountId), { ok: true })
  const fresh = db
    .prepare('SELECT status,last_seen_at lastSeen FROM social_accounts WHERE id=?')
    .get(accountId)
  assert.equal(fresh.status, 'connected')
  assert(fresh.lastSeen)
  assert.equal(findBestAccountForVehicle(db, owner.org, 12345)?.id, accountId)

  // Persist the last explicit consumer signal without treating it as fresh.
  for (const autoRun of [true,false,undefined]) {
    await api('/extension/presence', {
      method: 'POST',
      body: JSON.stringify({ accountId, autoRun }),
    })
    const persisted = db.prepare('SELECT last_consumer_auto_run value FROM social_accounts WHERE id=?').get(accountId)
    assert.equal(persisted.value, autoRun===undefined?null:Number(autoRun))
  }

  // A paused profile may report liveness but must remain unavailable for scheduling.
  db.prepare(
    "UPDATE social_accounts SET automation_paused=1,last_seen_at=datetime('now','-20 minutes') WHERE id=?",
  ).run(accountId)
  assert.deepEqual(await presence(accountId), { ok: true })
  const paused = db
    .prepare(
      'SELECT automation_paused paused,last_seen_at lastSeen FROM social_accounts WHERE id=?',
    )
    .get(accountId)
  assert.equal(paused.paused, 1)
  assert(paused.lastSeen)
  assert.equal(findBestAccountForVehicle(db, owner.org, 12345), null)

  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8')
  assert(background.includes('async function reportExtensionPresence()'))
  assert(background.includes('await reportExtensionPresence()'))
  assert(background.includes('void reportExtensionPresence()'))
  const view = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  for (const state of ['Extensão conectada', 'Sem sinal recente', 'Automação pausada']) {
    assert(view.includes(state))
  }
  console.log('OK: presença por perfil, isolamento, pausa e distribuição com sinal recente.')
} finally {
  db.close()
  await server.close()
}
