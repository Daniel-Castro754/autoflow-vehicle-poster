import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { sendCriticalAlert } from '../services/alerting.ts'
import { getAlertCredentials } from '../services/credential-vault.ts'

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
  const settings = getAlertCredentials(db, auth.organizationId)
  const result = await sendCriticalAlert(
    {
      jobId: 0,
      accountLabel: 'Teste do Sistema',
      type: 'test_alert',
      message: 'Este é um disparo de teste da integração de alertas autônomos do AutoFlow.',
      attemptCount: 1,
    },
    {
      telegramBotToken: settings.telegramBotToken,
      telegramChatId: settings.telegramChatId,
      webhookUrl: settings.webhookUrl,
    },
  )
  send(res, 200, { ok: true, result })
  return true
}
