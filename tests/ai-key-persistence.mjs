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
  const org = db.prepare('SELECT organization_id id FROM users WHERE email=?').get(server.email).id
  const gemini = 'test-gemini-private-API-key-should-never-appear'
  const openai = 'test-openai-private-API-key-should-never-appear'
  const company = 'Empresa AI Teste'
  const patch = async (fields) => api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      organizationName: company, defaultLocation: 'Criciúma, SC',
      groups: [], ...fields,
    }),
  })
  const dbKeys = () => db.prepare(
    'SELECT gemini_api_key gemini,openai_api_key openai,ai_provider preference FROM organization_settings WHERE organization_id=?',
  ).get(org)
  const initial = await api('/settings')
  assert(!('geminiApiKey' in initial.settings) && !('openaiApiKey' in initial.settings))
  await patch({ geminiApiKey: gemini, openaiApiKey: openai, aiProvider: 'gemini' })
  let stored = dbKeys()
  assert.equal(stored.gemini, gemini)
  assert.equal(stored.openai, openai)
  assert.equal(stored.preference, 'gemini')
  const saved = await api('/settings')
  assert.equal(saved.settings.geminiKeyConfigured, true)
  assert.equal(saved.settings.openaiKeyConfigured, true)
  assert.equal(saved.settings.geminiKeySource, 'database')
  assert.equal(saved.settings.openaiKeySource, 'database')
  assert(!JSON.stringify(saved).includes(gemini))
  assert(!JSON.stringify(saved).includes(openai))
  await patch({ defaultLocation: 'Içara, SC' })
  await patch({ geminiApiKey: '', openaiApiKey: '', aiProvider: 'openai' })
  stored = dbKeys()
  assert.equal(stored.gemini, gemini, 'empty must not erase stored API key')
  assert.equal(stored.openai, openai)
  assert.equal(stored.preference, 'openai')
  // Open a second connection to verify credentials are persisted on disk, not in memory.
  const secondDb = new DatabaseSync(join(server.dataDir, 'autoflow.db'), { readOnly: true })
  assert.equal(secondDb.prepare('SELECT gemini_api_key key FROM organization_settings WHERE organization_id=?').get(org).key, gemini)
  secondDb.close()

  // No key value or prompt/description should appear in the audit trail.
  const generation = await patch({ aiProvider: 'procedural' })
  assert.equal(generation.ok, true)
  const response = await api('/ai/generate-description', {
    method: 'POST',
    body: JSON.stringify({ year: 2022, make: 'Toyota', model: 'Corolla', km: 40000, price: 92000 }),
  })
  assert.equal(response.provider, 'procedural')
  await api('/ai/command', {
    method: 'POST', body: JSON.stringify({ prompt: 'Auditar saúde do estoque ' + gemini }),
  })
  const history = await api('/ai/history')
  assert(history.history.some((event) => event.action === 'ai_configuration_saved'))
  assert(history.history.some((event) => event.action === 'description_generated' && event.provider === 'procedural'))
  assert(history.history.some((event) => event.action === 'assistant_command'))
  assert(!JSON.stringify(history).includes(gemini))
  assert(!JSON.stringify(history).includes(openai))
  const provider = await api('/ai/provider-status')
  assert.equal(provider.preference, 'procedural')
  assert.equal(provider.geminiConfigured, true)
  assert.equal(provider.openaiConfigured, true)

  await assert.rejects(patch({ clearGeminiApiKey: 'yes' }), (err) => err.status === 400)
  assert.equal(dbKeys().gemini, gemini)
  await patch({ clearGeminiApiKey: true, clearOpenaiApiKey: true })
  assert.equal(dbKeys().gemini, '')
  assert.equal(dbKeys().openai, '')
  assert.equal((await api('/settings')).settings.geminiKeySource, process.env.GEMINI_API_KEY ? 'environment' : 'none')

  // Tenants cannot read other tenants' AI audit history.
  const foreign = Number(db.prepare("INSERT INTO organizations(name) VALUES('Loja Externa')").run().lastInsertRowid)
  db.prepare("INSERT INTO ai_operation_history(organization_id,user_id,action,outcome) VALUES(?,NULL,'api_key_test','tested')").run(foreign)
  const ownHistory = await api('/ai/history')
  assert(!ownHistory.history.some((event) => event.action === 'api_key_test'))
  console.log('✓ API keys persist, blank settings preserve them, explicit removal, private status and redacted AI audit history')
} finally {
  db.close()
  await server.close()
}
