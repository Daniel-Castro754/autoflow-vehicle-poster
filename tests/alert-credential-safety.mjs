import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'
import { validateWebhookAddress } from '../server/services/alert-secrets.ts'

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
  const telegram = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde0123456789'
  const chat = '-1001234567890'
  const webhook = 'https://hooks.example.org/my-private-test-secret'
  const patch = async (fields) =>
    api('/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        organizationName: 'Loja de Alertas',
        defaultLocation: 'Criciúma, SC',
        groups: [],
        ...fields,
      }),
    })
  const stored = () =>
    db
      .prepare(
        'SELECT alert_telegram_token token,alert_telegram_chat_id chat,alert_webhook_url webhook FROM organization_settings WHERE organization_id=?',
      )
      .get(org)
  const initial = await api('/settings')
  for (const field of ['alertTelegramToken', 'alertTelegramChatId', 'alertWebhookUrl'])
    assert(!Object.hasOwn(initial.settings, field), 'GET must not expose ' + field)

  await patch({ alertTelegramToken: telegram, alertTelegramChatId: chat, alertWebhookUrl: webhook })
  let row = stored()
  assert([row.token, row.chat, row.webhook].every((v) => v.startsWith('enc:v1:')))
  assert(!JSON.stringify(row).includes('my-private-test-secret'))
  let response = await api('/settings')
  assert.equal(response.settings.alertTelegramConfigured, true)
  assert.equal(response.settings.alertChatConfigured, true)
  assert.equal(response.settings.alertWebhookConfigured, true)
  assert.equal(response.settings.alertTelegramSource, 'database')
  assert.equal(response.settings.alertWebhookSource, 'database')
  assert(!JSON.stringify(response).includes(telegram))
  assert(!JSON.stringify(response).includes(chat))
  assert(!JSON.stringify(response).includes(webhook))

  await patch({ autoRetry: true })
  await patch({ alertTelegramToken: '', alertTelegramChatId: '', alertWebhookUrl: '' })
  assert.deepEqual(stored(), row, 'Omitted and empty fields must not erase credentials')
  await assert.rejects(
    patch({ alertWebhookUrl: 'http://localhost:3333/admin' }),
    (err) => err.status === 400,
  )
  await assert.rejects(
    patch({ alertWebhookUrl: 'https://127.0.0.1/admin' }),
    (err) => err.status === 400,
  )
  await assert.rejects(
    patch({ alertWebhookUrl: 'https://user:pass@hooks.example.org/' }),
    (err) => err.status === 400,
  )
  await assert.rejects(
    patch({ alertWebhookUrl: 'https://hooks.example.org:4443/' }),
    (err) => err.status === 400,
  )
  await assert.rejects(patch({ alertTelegramToken: 'not-a-token' }), (err) => err.status === 400)
  assert.deepEqual(stored(), row, 'Rejected settings must preserve all prior ciphertext')

  await assert.rejects(patch({ clearAlertWebhookUrl: 'yes' }), (err) => err.status === 400)
  await assert.rejects(
    patch({ clearAlertWebhookUrl: true, alertWebhookUrl: webhook }),
    (err) => err.status === 400,
  )
  assert.deepEqual(stored(), row)

  await patch({ clearAlertWebhookUrl: true })
  assert.equal(stored().webhook, '')
  assert.equal((await api('/settings')).settings.alertWebhookConfigured, false)
  assert.equal(stored().token, row.token)
  await patch({ clearAlertTelegramToken: true, clearAlertTelegramChatId: true })
  assert.deepEqual({ ...stored() }, { token: '', chat: '', webhook: '' })

  const foreign = Number(
    db.prepare("INSERT INTO organizations(name) VALUES('Loja externa')").run().lastInsertRowid,
  )
  db.prepare(
    'INSERT INTO organization_settings (organization_id,alert_telegram_token) VALUES (?,?)',
  ).run(foreign, 'foreign-plaintext-token')
  const foreignSettings = await api('/settings')
  assert(!JSON.stringify(foreignSettings).includes('foreign-plaintext-token'))
  assert.equal(
    validateWebhookAddress('https://hooks.example.org/path'),
    'https://hooks.example.org/path',
  )
  for (const address of [
    'https://localhost/path',
    'https://192.168.1.2/path',
    'https://service.internal/hook',
    'ftp://hooks.example.org/hook',
    'http://hooks.example.org/hook',
  ])
    assert.throws(() => validateWebhookAddress(address))
  console.log(
    '✓ Alerts protected: stored ciphertext, scoped API, partial settings, explicit clear, unsafe URL rejection',
  )
} finally {
  db.close()
  await server.close()
}
