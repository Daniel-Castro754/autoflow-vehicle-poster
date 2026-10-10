import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'

const server = await startTestServer()
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
try {
  const anonymous = createApiClient(server.base, '')
  const login = await anonymous('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const api = createApiClient(server.base, login.token)
  const org = db.prepare('SELECT organization_id id FROM users WHERE email=?')
    .get(server.email).id
  const groups = Array.from({ length: 39 }, (_, index) => ({
    name: 'Grupo local ' + (index + 1),
    url: '',
    city: index % 2 === 0 ? 'Criciúma' : 'Florianópolis',
    state: 'SC',
    memberCount: (index + 1) * 1200,
    active: index % 6 !== 0,
    privacy: 'Público',
    priority: index + 1,
  }))
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      organizationName: 'Teste de Grupos',
      defaultLocation: 'Criciúma, SC',
      groups,
    }),
  })
  const rows = () => db.prepare(
    'SELECT id,name,active,priority,member_count members FROM marketplace_groups WHERE organization_id=? ORDER BY id',
  ).all(org)
  const before = rows()
  assert.equal(before.length, 39)
  const activeBefore = before.filter((g) => g.active).length
  const preview = await api('/groups/curated')
  assert.equal(preview.total, 39)
  assert.equal(preview.activeCount, activeBefore)
  assert.equal(rows().length, 39, 'Preview must be read only')
  await assert.rejects(
    api('/groups/auto-curate', { method: 'POST' }),
    (error) => error.status === 428,
  )
  // Changing active status after the preview must invalidate its digest.
  db.prepare('UPDATE marketplace_groups SET active=1-active WHERE id=?').run(before[0].id)
  await assert.rejects(
    api('/groups/auto-curate?previewDigest=' + preview.previewDigest, { method: 'POST' }),
    (error) => error.status === 409,
  )
  db.prepare('UPDATE marketplace_groups SET active=? WHERE id=?')
    .run(before[0].active, before[0].id)
  const valid = await api('/groups/curated')
  const curated = await api('/groups/auto-curate?previewDigest=' + valid.previewDigest, {
    method: 'POST',
  })
  assert.equal(curated.curatedCount, 39)
  const after = rows()
  assert.equal(after.length, 39)
  for (const original of before) {
    const updated = after.find((group) => group.id === original.id)
    assert(updated)
    assert.equal(updated.active, original.active, 'Ranking must not disable groups')
    assert.equal(updated.members, original.members, 'Ranking must not rewrite member counts')
  }
  const settings = await api('/settings')
  assert.equal(settings.settings.targetGroups.length, Math.min(20, activeBefore))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM group_curation_history WHERE organization_id=?').get(org).n, 1)

  // Assistant command must only suggest a ranking, never change the database.
  const beforeCommand = rows()
  const command = await api('/ai/command', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'Reordenar grupos por prioridade' }),
  })
  assert.equal(command.actionTaken, 'preview_group_ranking')
  assert.deepEqual(rows(), beforeCommand)

  const undone = await api('/groups/undo-curation', { method: 'POST' })
  assert.equal(undone.groups.length, 39)
  assert.deepEqual(rows(), before, 'Undo must restore the exact priorities')
  await assert.rejects(
    api('/groups/undo-curation', { method: 'POST' }),
    (error) => error.status === 409,
  )

  // Older/partial settings clients cannot erase the group catalog by omission.
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      organizationName: 'Teste de Grupos',
      defaultLocation: 'Criciúma, SC',
      groups: [],
    }),
  })
  assert.equal(rows().length, 39)
  const chosen = rows()[0]
  const keep = (await api('/settings')).settings.groups.filter((g) => g.id !== chosen.id)
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      organizationName: 'Teste de Grupos',
      defaultLocation: 'Criciúma, SC',
      groups: keep,
      deletedGroupIds: [chosen.id],
    }),
  })
  assert.equal(rows().length, 38, 'Explicit deletion must remove exactly one group')

  const secondOrg = Number(db.prepare("INSERT INTO organizations(name) VALUES('Outra empresa')")
    .run().lastInsertRowid)
  db.prepare("INSERT INTO marketplace_groups(organization_id,name,priority) VALUES(?,'Outra empresa grupo',1)")
    .run(secondOrg)
  const foreign = db.prepare('SELECT COUNT(*) n FROM marketplace_groups WHERE organization_id=?')
    .get(secondOrg).n
  assert.equal(foreign, 1, 'Cross-organization catalog must remain isolated')
  console.log('✓ Group safety: 39 groups, active preservation, preview fencing, undo and explicit deletions')
} finally {
  db.close()
  await server.close()
}
