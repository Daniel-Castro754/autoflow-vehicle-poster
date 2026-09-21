import { logger } from '../lib/logger.ts'

export interface AlertConfig {
  telegramBotToken?: string
  telegramChatId?: string
  webhookUrl?: string
}

export interface CriticalErrorAlert {
  jobId?: number
  accountLabel?: string
  message: string
  attemptCount?: number
  type?: string
  details?: Record<string, unknown>
  timestamp?: string
}

export async function sendCriticalAlert(
  alert: CriticalErrorAlert,
  config?: AlertConfig
): Promise<{ telegram: boolean; webhook: boolean }> {
  const telegramBotToken = (config?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || '').trim()
  const telegramChatId = (config?.telegramChatId || process.env.TELEGRAM_CHAT_ID || '').trim()
  const webhookUrl = (config?.webhookUrl || process.env.ALERT_WEBHOOK_URL || '').trim()

  const timestamp = alert.timestamp || new Date().toISOString()
  const jobInfo = alert.jobId ? `#${alert.jobId}` : 'N/A'
  const accountInfo = alert.accountLabel || 'Sistema'
  const attempts = alert.attemptCount !== undefined ? String(alert.attemptCount) : '1'

  const message = [
    '🚨 *Alerta Crítico no AutoFlow*',
    `• *Tipo:* ${alert.type || 'Falha de Publicação'}`,
    `• *Trabalho:* ${jobInfo}`,
    `• *Perfil:* ${accountInfo}`,
    `• *Erro:* ${alert.message}`,
    `• *Tentativas:* ${attempts}`,
    `• *Timestamp:* ${timestamp}`,
  ].join('\n')

  let telegramSuccess = false
  let webhookSuccess = false

  if (telegramBotToken && telegramChatId) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: message,
          parse_mode: 'Markdown',
        }),
      })
      telegramSuccess = response.ok
      if (!response.ok) {
        logger.warn('AutoFlowAlert', `Telegram respondeu com status ${response.status}`, { body: await response.text() })
      }
    } catch (err) {
      logger.warn('AutoFlowAlert', 'Erro ao enviar alerta para o Telegram', { error: err instanceof Error ? err.message : err })
    }
  }

  if (webhookUrl) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'autoflow-vehicle-poster',
          severity: 'critical',
          ...alert,
          timestamp,
        }),
      })
      webhookSuccess = response.ok
      if (!response.ok) {
        logger.warn('AutoFlowAlert', `Webhook respondeu com status ${response.status}`)
      }
    } catch (err) {
      logger.warn('AutoFlowAlert', 'Erro ao enviar alerta para webhook', { error: err instanceof Error ? err.message : err })
    }
  }

  return { telegram: telegramSuccess, webhook: webhookSuccess }
}
