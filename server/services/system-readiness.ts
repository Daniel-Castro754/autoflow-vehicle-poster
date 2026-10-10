import type { DatabaseSync } from 'node:sqlite'
import { operationalHealth } from './operational-health.ts'

export type ReadinessState = 'ok' | 'attention' | 'inactive' | 'unknown'
export type ReadinessSection = 'security' | 'integrations' | 'automation'

type Check = {
  id: string
  section: ReadinessSection
  title: string
  status: ReadinessState
  detail: string
  page: string
}

type SettingRow = {
  gemini: string
  openai: string
  preference: string
  telegram: string
  chat: string
  webhook: string
  pilot: number
  fillGroups: number
  autoPublish: number
  autoAdvance: number
  dailyLimit: number
}

function number(value: unknown): number {
  return Number(value) || 0
}

/**
 * A read-only snapshot derived entirely from local records. No remote API
 * calls, automated job creation, credential decryption or mutations.
 * Configuration is NOT evidence that an external provider works.
 */
export function systemReadiness(db: DatabaseSync, org: number) {
  const row = db
    .prepare(
      `SELECT gemini_api_key gemini,openai_api_key openai,ai_provider preference,
      alert_telegram_token telegram,alert_telegram_chat_id chat,alert_webhook_url webhook,
      autopilot_enabled pilot,fill_groups fillGroups,auto_publish autoPublish,
      auto_advance autoAdvance,daily_limit dailyLimit
      FROM organization_settings WHERE organization_id=?`,
    )
    .get(org) as SettingRow | undefined
  if (!row) throw new Error('Empresa sem configurações.')

  const health = operationalHealth(db, org)
  const account = db
    .prepare(
      `SELECT COUNT(*) total,
       COALESCE(SUM(automation_paused=1),0) paused,
       COALESCE(SUM(status='connected'),0) connected,
       COALESCE(SUM(status='connected' AND last_seen_at IS NOT NULL
         AND datetime(last_seen_at)>=datetime('now','-5 minutes')),0) recent
      FROM social_accounts WHERE organization_id=?`,
    )
    .get(org) as { total: number; paused: number; connected: number; recent: number }

  const vehicles = db
    .prepare(
      `SELECT COUNT(*) ready,
      COALESCE(SUM(EXISTS (
        SELECT 1 FROM vehicle_images i WHERE i.organization_id=v.organization_id AND i.vehicle_id=v.id
      ) AND NOT EXISTS (
        SELECT 1 FROM publication_jobs j WHERE j.organization_id=v.organization_id AND j.vehicle_id=v.id
          AND j.status IN ('pending','filling','error','awaiting_confirmation','completed')
      )),0) basicCandidates
      FROM vehicles v WHERE v.organization_id=? AND v.status='Pronto' AND v.sold_at IS NULL`,
    )
    .get(org) as { ready: number; basicCandidates: number }

  const groups = db
    .prepare(
      'SELECT COUNT(*) total, COALESCE(SUM(active=1),0) active FROM marketplace_groups WHERE organization_id=?',
    )
    .get(org) as { total: number; active: number }

  const snapshot = db
    .prepare(
      `SELECT last_status lastStatus,last_finished_at lastFinishedAt,last_jobs_created lastJobsCreated,
      next_run_at nextRunAt
      FROM autopilot_state WHERE organization_id=?`,
    )
    .get(org) as
    | {
        lastStatus: string | null
        lastFinishedAt: string | null
        lastJobsCreated: number
        nextRunAt: string | null
      }
    | undefined

  const credentials = [row.gemini, row.openai, row.telegram, row.chat, row.webhook].filter(
    (value) => Boolean(value),
  )
  const legacyCredentials = credentials.filter((value) => !value.startsWith('enc:v1:')).length
  const configuredGemini = Boolean(row.gemini || process.env.GEMINI_API_KEY)
  const configuredOpenai = Boolean(row.openai || process.env.OPENAI_API_KEY)
  const configuredTelegram = Boolean(row.telegram || process.env.TELEGRAM_BOT_TOKEN)
  const configuredChat = Boolean(row.chat || process.env.TELEGRAM_CHAT_ID)
  const configuredWebhook = Boolean(row.webhook || process.env.ALERT_WEBHOOK_URL)
  const aiPreference = ['auto', 'gemini', 'openai', 'procedural'].includes(row.preference)
    ? row.preference
    : 'auto'

  const checks: Check[] = []
  const add = (
    id: string,
    section: ReadinessSection,
    title: string,
    status: ReadinessState,
    detail: string,
    page: string,
  ) => checks.push({ id, section, title, status, detail, page })

  add(
    'vault',
    'security',
    'Cofre local de credenciais',
    legacyCredentials ? 'attention' : 'ok',
    legacyCredentials
      ? `${legacyCredentials} campo(s) ainda em texto no banco. Verifique a migração e os backups.`
      : 'Cofre inicializado no servidor. Credenciais cadastradas no banco usam formato cifrado.',
    'Configurações',
  )
  add(
    'backup',
    'security',
    'Backup e recuperação',
    'unknown',
    'Nenhum backup foi verificado nesta consulta. Confirme a integridade e a recuperação separadamente.',
    'Configurações',
  )
  const paidReady =
    aiPreference === 'gemini'
      ? configuredGemini
      : aiPreference === 'openai'
        ? configuredOpenai
        : configuredGemini || configuredOpenai
  add(
    'ai',
    'integrations',
    'Geração por IA',
    aiPreference === 'procedural' ? 'inactive' : paidReady ? 'ok' : 'attention',
    aiPreference === 'procedural'
      ? 'Modo offline selecionado. Nenhuma chamada a modelos externos.'
      : paidReady
        ? 'Provedor configurado; conectividade, créditos e qualidade do resultado não foram testados.'
        : 'Sem chave para o provedor escolhido. Descrições poderão usar o fallback offline.',
    'Central de IA',
  )
  add(
    'telegram',
    'integrations',
    'Alertas Telegram',
    configuredTelegram && configuredChat
      ? 'ok'
      : configuredTelegram || configuredChat
        ? 'attention'
        : 'inactive',
    configuredTelegram && configuredChat
      ? 'Token e destino configurados; envio real não verificado.'
      : configuredTelegram || configuredChat
        ? 'Integração incompleta: confira token e Chat ID.'
        : 'Telegram não configurado. Opcional quando outro canal atende aos alertas.',
    'Configurações',
  )
  add(
    'webhook',
    'integrations',
    'Alertas por webhook',
    configuredWebhook ? 'ok' : 'inactive',
    configuredWebhook
      ? 'Destino configurado; disponibilidade HTTP não verificada.'
      : 'Nenhum webhook cadastrado.',
    'Configurações',
  )
  add(
    'profiles',
    'automation',
    'Perfis e extensão',
    !number(account.total)
      ? 'attention'
      : number(account.paused) || !number(account.recent)
        ? 'attention'
        : 'ok',
    !number(account.total)
      ? 'Nenhum perfil cadastrado para executar publicações.'
      : `${number(account.recent)} extensão(ões) com sinal recente; ${number(account.paused)} perfil(is) pausado(s). O sinal não confirma sessão Facebook válida.`,
    'Equipe e contas',
  )
  add(
    'inventory',
    'automation',
    'Estoque elegível',
    number(vehicles.basicCandidates) ? 'ok' : 'inactive',
    `${number(vehicles.basicCandidates)} veículo(s) Pronto com foto e sem trabalho aberto/concluído. Elegibilidade final depende das demais regras de publicação.`,
    'Veículos',
  )
  add(
    'groups',
    'automation',
    'Grupos do Marketplace',
    !row.fillGroups ? 'inactive' : number(groups.active) ? 'ok' : 'attention',
    !row.fillGroups
      ? 'Preenchimento de grupos desativado.'
      : number(groups.active)
        ? `${number(groups.active)} grupo(s) ativo(s); associação e acesso no Facebook não verificados.`
        : 'Preenchimento de grupos ativado, mas nenhum grupo ativo foi encontrado.',
    'Configurações',
  )
  const hasBlockedAutomation = Boolean(
    !account.recent ||
    account.paused ||
    (row.fillGroups && !groups.active) ||
    health.stuckJobsCount ||
    health.expiredLeasesCount ||
    snapshot?.lastStatus === 'error',
  )
  add(
    'pilot',
    'automation',
    'Agendamento autônomo',
    !row.pilot
      ? 'inactive'
      : hasBlockedAutomation
        ? 'attention'
        : !vehicles.basicCandidates
          ? 'inactive'
          : 'ok',
    !row.pilot
      ? 'Agendamento recorrente desativado.'
      : hasBlockedAutomation
        ? 'Agendamento ativado com impedimentos ou alertas. Revise perfis, grupos e execuções.'
        : !vehicles.basicCandidates
          ? 'Agendamento ativo, aguardando veículos elegíveis.'
          : 'Pré-condições básicas presentes. A publicação exige validações em tempo real.',
    'Central de IA',
  )
  add(
    'jobs',
    'automation',
    'Fila e confirmações',
    health.stuckJobsCount || health.expiredLeasesCount || health.jobs.awaitingConfirmation
      ? 'attention'
      : 'ok',
    `${health.jobs.pending} na fila, ${health.jobs.active} em andamento, ${health.jobs.awaitingConfirmation} aguardando confirmação, ${health.stuckJobsCount} travado(s).`,
    'Publicações',
  )

  const status: 'attention' | 'ready' | 'idle' = checks.some(
    (check) => check.status === 'attention',
  )
    ? 'attention'
    : row.pilot && vehicles.basicCandidates && account.recent
      ? 'ready'
      : 'idle'
  return {
    generatedAt: new Date().toISOString(),
    evidence:
      'Dados locais e preferências. Esta consulta não testa redes, chaves externas nem cria publicações.',
    status,
    checks,
    summary: {
      attention: checks.filter((check) => check.status === 'attention').length,
      configured: checks.filter((check) => check.status === 'ok').length,
      inactive: checks.filter((check) => check.status === 'inactive').length,
      unverified: checks.filter((check) => check.status === 'unknown').length,
    },
    automation: {
      enabled: Boolean(row.pilot),
      autoPublish: Boolean(row.autoPublish),
      autoAdvance: Boolean(row.autoAdvance),
      lastStatus: snapshot?.lastStatus || null,
      lastFinishedAt: snapshot?.lastFinishedAt || null,
      nextRunAt: snapshot?.nextRunAt || null,
      basicCandidates: number(vehicles.basicCandidates),
      activeGroups: number(groups.active),
      totalProfiles: number(account.total),
      recentProfiles: number(account.recent),
      pausedProfiles: number(account.paused),
    },
  }
}
