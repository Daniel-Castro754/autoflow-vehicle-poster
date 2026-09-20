import type { DatabaseSync } from 'node:sqlite'
import { runAutopilotPipeline } from './ai-agent.ts'
import { sendCriticalAlert } from './alerting.ts'

interface AutopilotSettings {
  autopilotEnabled: boolean
  scheduleTimes: string[]
}

let workerInterval: NodeJS.Timeout | null = null
let lastExecutedMinute: string = ''

/**
 * Lê as configurações de agendamento do Piloto Automático do banco.
 */
export function getAutopilotSettings(
  db: DatabaseSync,
  organizationId: number
): AutopilotSettings {
  const row = db
    .prepare(
      `
      SELECT
        COALESCE(autopilot_enabled, 1) autopilotEnabled,
        COALESCE(autopilot_schedule_times, '08:30,11:30,17:30') scheduleTimes
      FROM organization_settings
      WHERE organization_id = ?
    `
    )
    .get(organizationId) as { autopilotEnabled?: number; scheduleTimes?: string } | undefined

  const scheduleTimes = (row?.scheduleTimes || '08:30,11:30,17:30')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  return {
    autopilotEnabled: Boolean(row?.autopilotEnabled ?? 1),
    scheduleTimes,
  }
}

/**
 * Executa uma rodada do Piloto Automático em segundo plano.
 */
export async function executeAutopilotTick(
  db: DatabaseSync,
  force: boolean = false
): Promise<{ executed: boolean; reason: string; jobsCreated?: number }> {
  const now = new Date()
  // Formata hora atual no padrão HH:MM no fuso local
  const currentHour = String(now.getHours()).padStart(2, '0')
  const currentMinute = String(now.getMinutes()).padStart(2, '0')
  const currentHHMM = `${currentHour}:${currentMinute}`

  // Evita rodar duas vezes no mesmo minuto
  if (!force && lastExecutedMinute === currentHHMM) {
    return { executed: false, reason: 'already_executed_this_minute' }
  }

  // Busca todas as organizações ativas
  const orgs = db
    .prepare(`SELECT id FROM organizations`)
    .all() as Array<{ id: number }>

  let totalJobs = 0

  for (const org of orgs) {
    const settings = getAutopilotSettings(db, org.id)

    if (!force && !settings.autopilotEnabled) {
      continue
    }

    // Verifica se o horário atual coincide com os horários programados
    const isScheduledTime = settings.scheduleTimes.includes(currentHHMM)
    if (!force && !isScheduledTime) {
      continue
    }

    try {
      const adminUser = db
        .prepare('SELECT id FROM users WHERE organization_id = ? ORDER BY id ASC LIMIT 1')
        .get(org.id) as { id: number } | undefined
      const userId = adminUser?.id || 1

      const result = await runAutopilotPipeline(db, org.id, userId)

      totalJobs += result.jobsCreated

      if (result.jobsCreated > 0) {
        const orgSettings = db
          .prepare(
            'SELECT alert_telegram_token alertTelegramToken, alert_telegram_chat_id alertTelegramChatId, alert_webhook_url alertWebhookUrl FROM organization_settings WHERE organization_id = ?'
          )
          .get(org.id) as
          | {
              alertTelegramToken?: string
              alertTelegramChatId?: string
              alertWebhookUrl?: string
            }
          | undefined

        // Envia notificação informativa no Telegram/Webhook
        await sendCriticalAlert(
          {
            type: 'INFO_AUTOPILOT_RUN',
            message: `🚀 Piloto Automático AutoFlow (${currentHHMM}) agendou ${result.jobsCreated} veículo(s) para as próximas janelas de pico automotivo.`,
          },
          {
            telegramBotToken: orgSettings?.alertTelegramToken,
            telegramChatId: orgSettings?.alertTelegramChatId,
            webhookUrl: orgSettings?.alertWebhookUrl,
          }
        )
      }
    } catch (err) {
      console.error(
        `[AutopilotWorker] Erro ao executar pipeline para org ${org.id}:`,
        err
      )
    }
  }

  lastExecutedMinute = currentHHMM
  return { executed: true, reason: 'scheduled_trigger', jobsCreated: totalJobs }
}

/**
 * Inicia o worker em segundo plano com verificação a cada 30 segundos.
 */
export function startAutopilotWorker(
  db: DatabaseSync,
  intervalMs: number = 30000
): NodeJS.Timeout {
  if (workerInterval) {
    clearInterval(workerInterval)
  }

  workerInterval = setInterval(async () => {
    try {
      await executeAutopilotTick(db)
    } catch (err) {
      console.error('[AutopilotWorker] Erro inesperado no ciclo:', err)
    }
  }, intervalMs)

  return workerInterval
}

/**
 * Interrompe o worker (usado em testes ou shutdown).
 */
export function stopAutopilotWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval)
    workerInterval = null
  }
}
