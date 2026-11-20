import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'

const server = await startTestServer()
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
const expectStatus = (promise, status) =>
  assert.rejects(promise, (error) => error.status === status)

try {
  const loginClient = createApiClient(server.base, '')
  const adminLogin = await loginClient('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const api = createApiClient(server.base, adminLogin.token)
  const owner = db
    .prepare('SELECT id,organization_id org FROM users WHERE email=?')
    .get(server.email)

  const create = (data) =>
    api('/social-accounts', { method: 'POST', body: JSON.stringify(data) })
  const edit = (id, data) =>
    api('/social-accounts/' + id, { method: 'PATCH', body: JSON.stringify(data) })
  const remove = (id, label) =>
    api('/social-accounts/' + id, {
      method: 'DELETE',
      body: JSON.stringify({ confirmLabel: label }),
    })
  const base = { userId: owner.id, label: 'Daniel', browserProfile: 'Daniel' }
  const first = await create(base)
  assert(first.id > 0)
  assert.equal(
    db.prepare('SELECT browser_profile profile FROM social_accounts WHERE id=?').get(first.id)
      .profile,
    'Daniel',
  )

  // Duplicate associations should not be created by accident.
  await expectStatus(create({ ...base, browserProfile: '  daniel ' }), 409)
  await expectStatus(create({ ...base, browserProfile: ' ' }), 400)
  await expectStatus(create({ ...base, label: ' ' }), 400)
  await expectStatus(create({ ...base, userId: -1 }), 400)
  await expectStatus(edit(first.id, { ...base, browserProfile: '' }), 400)
  await expectStatus(edit(first.id, { ...base, userId: '1' }), 400)
  await expectStatus(edit(999999, base), 404)
  await expectStatus(remove(first.id, 'wrong-name'), 400)

  const second = await create({ ...base, label: 'Facebook 02', browserProfile: 'Facebook 02' })
  await expectStatus(edit(second.id, { ...base, browserProfile: 'DANIEL' }), 409)
  const changed = await edit(first.id, {
    userId: owner.id,
    label: 'Daniel comercial',
    browserProfile: 'Daniel 2026',
  })
  assert.equal(changed.label, 'Daniel comercial')
  assert.equal(changed.browserProfile, 'Daniel 2026')
  const team = await api('/team')
  assert(
    team.accounts.some(
      (account) =>
        account.id === first.id &&
        account.browserProfile === 'Daniel 2026' &&
        account.label === 'Daniel comercial',
    ),
  )

  // Seller cannot edit or delete, even when the profile is assigned to that seller.
  const sellerPassword = 'password-test-strong-123'
  await api('/team/users', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Vendedor', email: 'seller-profiles@test.local', password: sellerPassword, role: 'seller',
    }),
  })
  const sellerLogin = await loginClient('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'seller-profiles@test.local', password: sellerPassword }),
  })
  const sellerApi = createApiClient(server.base, sellerLogin.token)
  await expectStatus(
    sellerApi('/social-accounts/' + first.id, {
      method: 'PATCH',
      body: JSON.stringify({ ...base, label: 'Hack' }),
    }),
    403,
  )
  await expectStatus(
    sellerApi('/social-accounts/' + first.id, {
      method: 'DELETE',
      body: JSON.stringify({ confirmLabel: 'Daniel comercial' }),
    }),
    403,
  )

  // Tenant boundary must hold for both mutations.
  const otherOrg = Number(
    db.prepare("INSERT INTO organizations(name) VALUES ('Outra empresa')").run().lastInsertRowid,
  )
  const foreign = Number(
    db.prepare('INSERT INTO social_accounts(organization_id,user_id,label,browser_profile) VALUES(?,?,?,?)')
      .run(otherOrg, owner.id, 'Outra conta', 'Outra janela').lastInsertRowid,
  )
  await expectStatus(edit(foreign, { ...base, browserProfile: 'Atualizada' }), 404)
  await expectStatus(remove(foreign, 'Outra conta'), 404)
  await expectStatus(edit(first.id, { ...base, userId: 999999 }), 400)

  // A historical reference is never erased to remove a linked account.
  const vehicle = Number(
    db.prepare("INSERT INTO vehicles(organization_id,year,make,model) VALUES (?,2024,'Toyota','Corolla')")
      .run(owner.org).lastInsertRowid,
  )
  const job = Number(
    db.prepare(
      "INSERT INTO publication_jobs(organization_id,vehicle_id,social_account_id,status) VALUES (?,?,?,'completed')",
    ).run(owner.org, vehicle, first.id).lastInsertRowid,
  )
  await expectStatus(remove(first.id, 'Daniel comercial'), 409)
  assert(db.prepare('SELECT id FROM publication_jobs WHERE id=?').get(job))

  // Even accounts only mentioned as past transfer participants cannot be deleted.
  const transferAccount = await create({
    ...base, label: 'Transferencia', browserProfile: 'Transferencia',
  })
  db.prepare(
    "INSERT INTO publication_job_events(organization_id,publication_job_id,event_type,from_account_id) VALUES (?,?,'transferred',?)",
  ).run(owner.org, job, transferAccount.id)
  await expectStatus(remove(transferAccount.id, 'Transferencia'), 409)

  // Unused profile can be removed without touching other profiles or their jobs.
  const removed = await remove(second.id, 'Facebook 02')
  assert.equal(removed.ok, true)
  assert.equal(
    db.prepare('SELECT id FROM social_accounts WHERE id=?').get(second.id),
    undefined,
  )
  assert(db.prepare('SELECT id FROM social_accounts WHERE id=?').get(first.id))
  assert(db.prepare('SELECT id FROM publication_jobs WHERE id=?').get(job))
  await expectStatus(remove(second.id, 'Facebook 02'), 404)
  console.log('OK: editar/excluir perfis, duplicados, permissões, isolamento e preservação histórica')
} finally {
  db.close()
  await server.close()
}
