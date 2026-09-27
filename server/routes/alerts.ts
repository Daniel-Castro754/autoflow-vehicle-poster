import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { sendCriticalAlert } from '../services/alerting.ts'

type AuthContext = { userId: number; organizationId: number }
type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  isAdmin: (auth: AuthContext) => boolean
}

export async function handleAlertRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext,
  { db, send, isAdmin }: Dependencies,
): Promise<boolean> {
  if (req.method !== 'POST' || url.pathname !== '/api/alerts/test') return false
  if (!isAdmin(auth)) {
    send(res, 403, { error: 'Somente administradores podem testar alertas.' })
    return true
  }
  const settings = db
    .prepare(
      'SELECT alert_telegram_token alertTelegramToken, alert_telegram_chat_id alertTelegramChatId, alert_webhook_url alertWebhookUrl FROM organization_settings WHERE organization_id = ?',
    )
    .get(auth.organizationId) as
    | { alertTelegramToken?: string; alertTelegramChatId?: string; alertWebhookUrl?: string }
    | undefined
  const result = await sendCriticalAlert(
    {
      jobId: 0,
      accountLabel: 'Teste do Sistema',
      type: 'test_alert',
      message: 'Este é um disparo de teste da integração de alertas autônomos do AutoFlow.',
      attemptCount: 1,
    },
    {
      telegramBotToken: settings?.alertTelegramToken,
      telegramChatId: settings?.alertTelegramChatId,
      webhookUrl: settings?.alertWebhookUrl,
    },
  )
  send(res, 200, { ok: true, result })
  return true
}
