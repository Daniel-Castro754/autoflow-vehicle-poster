import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { closeSelectorCircuitBreaker } from '../services/selector-health.ts'

type AuthContext = { userId: number; organizationId: number }
type Group = {
  id: number
  name: string
  url: string
  groupKey: string
  active: number
  priority: number
  successCount: number
  failureCount: number
  lastFoundAt?: string
}
type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  jsonBody: (req: IncomingMessage) => Promise<unknown>
  isAdmin: (auth: AuthContext) => boolean
  hashPassword: (password: string) => Promise<string>
  marketplaceGroups: (organizationId: number, activeOnly?: boolean) => Group[]
  validateGroupTarget: (value: unknown) => boolean
  replaceMarketplaceGroups: (organizationId: number, values: unknown[]) => Group[]
}

export async function handleOrganizationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext,
  {
    db,
    send,
    jsonBody,
    isAdmin,
    hashPassword,
    marketplaceGroups,
    validateGroupTarget,
    replaceMarketplaceGroups,
  }: Dependencies,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    const organization = db
      .prepare('SELECT id,name FROM organizations WHERE id=?')
      .get(auth.organizationId)
    const settings = db
      .prepare(
        `SELECT default_location defaultLocation,daily_limit dailyLimit,stuck_timeout_minutes stuckTimeoutMinutes,execution_interval_minutes executionIntervalMinutes,
      require_confirmation requireConfirmation,description_template descriptionTemplate,auto_advance autoAdvance,
      fill_groups fillGroups,target_groups targetGroups,auto_publish autoPublish,
      autopilot_enabled autopilotEnabled,autopilot_interval_minutes autopilotIntervalMinutes,
      auto_retry autoRetry,max_retries maxRetries,alert_telegram_token alertTelegramToken,alert_telegram_chat_id alertTelegramChatId,alert_webhook_url alertWebhookUrl,auto_curate_groups autoCurateGroups,
      gemini_api_key geminiApiKey,openai_api_key openaiApiKey,ai_provider aiProvider
      FROM organization_settings WHERE organization_id=?`,
      )
      .get(auth.organizationId) as Record<string, unknown>
    try {
      settings.targetGroups = JSON.parse(String(settings.targetGroups || '[]'))
    } catch {
      settings.targetGroups = []
    }
    settings.groups = marketplaceGroups(auth.organizationId)
    if (!settings.geminiApiKey && process.env.GEMINI_API_KEY)
      settings.geminiApiKey = process.env.GEMINI_API_KEY
    if (!settings.openaiApiKey && process.env.OPENAI_API_KEY)
      settings.openaiApiKey = process.env.OPENAI_API_KEY
    if (!isAdmin(auth)) {
      delete settings.geminiApiKey
      delete settings.openaiApiKey
      delete settings.alertTelegramToken
      delete settings.alertTelegramChatId
      delete settings.alertWebhookUrl
    }
    send(res, 200, { organization, settings })
    return true
  }

  if (req.method === 'PATCH' && url.pathname === '/api/settings') {
    if (!isAdmin(auth)) {
      send(res, 403, { error: 'Somente administradores podem alterar configurações.' })
      return true
    }
    const body = (await jsonBody(req)) as Record<string, unknown>
    if (!String(body.organizationName || '').trim()) {
      send(res, 400, { error: 'O nome da empresa é obrigatório.' })
      return true
    }
    const limit = Math.max(1, Math.min(50, Number(body.dailyLimit) || 10))
    const stuckTimeoutMinutes = Math.max(1, Math.min(120, Number(body.stuckTimeoutMinutes) || 15))
    const currentAutopilot = db
      .prepare(
        'SELECT autopilot_enabled enabled,autopilot_interval_minutes intervalMinutes,execution_interval_minutes executionIntervalMinutes FROM organization_settings WHERE organization_id=?',
      )
      .get(auth.organizationId) as {
      enabled: number
      intervalMinutes: number
      executionIntervalMinutes: number
    }
    const requestedInterval = Number(
      body.executionIntervalMinutes ?? currentAutopilot.executionIntervalMinutes,
    )
    const executionIntervalMinutes = Number.isFinite(requestedInterval)
      ? Math.max(0, Math.min(1440, requestedInterval))
      : 25
    const autoAdvance = body.autoAdvance === true
    const fillGroups = body.fillGroups === true
    const autoPublish = body.autoPublish === true
    // Older clients omit these fields; saving unrelated settings must not disable the worker.
    if (body.autopilotEnabled !== undefined && typeof body.autopilotEnabled !== 'boolean') {
      send(res, 400, { error: 'Informe se o agendamento recorrente deve ficar ativo.' })
      return true
    }
    const autopilotEnabled = body.autopilotEnabled ?? Boolean(currentAutopilot.enabled)
    const autopilotIntervalMinutes =
      body.autopilotIntervalMinutes === undefined
        ? currentAutopilot.intervalMinutes
        : body.autopilotIntervalMinutes
    if (
      typeof autopilotIntervalMinutes !== 'number' ||
      !Number.isInteger(autopilotIntervalMinutes) ||
      autopilotIntervalMinutes < 1 ||
      autopilotIntervalMinutes > 1440
    ) {
      send(res, 400, {
        error: 'O intervalo do agendamento recorrente deve ser um inteiro entre 1 e 1440 minutos.',
      })
      return true
    }
    const autoRetry = body.autoRetry === true
    const maxRetries = Math.max(1, Math.min(10, Number(body.maxRetries) || 3))
    const descriptionTemplate = String(body.descriptionTemplate || '').trim()
    const allowedTemplateVariables = new Set(['ano', 'marca', 'modelo', 'versao', 'km'])
    if (descriptionTemplate.length > 2000) {
      send(res, 400, { error: 'O modelo de descrição deve ter no máximo 2.000 caracteres.' })
      return true
    }
    if (
      [...descriptionTemplate.matchAll(/\{([^{}]+)\}/g)].some(
        ([, variable]) => !allowedTemplateVariables.has(variable.toLowerCase()),
      )
    ) {
      send(res, 400, { error: 'O modelo de descrição contém uma variável não suportada.' })
      return true
    }
    const alertTelegramToken = String(body.alertTelegramToken || '').trim()
    const alertTelegramChatId = String(body.alertTelegramChatId || '').trim()
    const alertWebhookUrl = String(body.alertWebhookUrl || '').trim()
    const autoCurateGroups = body.autoCurateGroups === true
    const geminiApiKey = String(body.geminiApiKey || '').trim()
    const openaiApiKey = String(body.openaiApiKey || '').trim()
    const aiProvider = ['auto', 'gemini', 'openai', 'procedural'].includes(String(body.aiProvider))
      ? String(body.aiProvider)
      : 'auto'
    const targetGroups = Array.isArray(body.targetGroups)
      ? [...new Set(body.targetGroups.map((value) => String(value).trim()).filter(Boolean))].slice(
          0,
          20,
        )
      : []
    const groupRecords = Array.isArray(body.groups) ? body.groups : targetGroups
    if (groupRecords.some((value) => !validateGroupTarget(value))) {
      send(res, 400, { error: 'Informe um nome e uma URL valida do Facebook para cada grupo.' })
      return true
    }
    if (fillGroups && !autoAdvance) {
      send(res, 400, { error: 'Ative o avanço automático para selecionar grupos.' })
      return true
    }
    if (
      fillGroups &&
      !groupRecords.some(
        (value) =>
          validateGroupTarget(value) &&
          (typeof value === 'string' ||
            (Boolean(value) &&
              typeof value === 'object' &&
              (value as Record<string, unknown>).active !== false)),
      )
    ) {
      send(res, 400, { error: 'Mantenha pelo menos um grupo ativo para preencher.' })
      return true
    }
    if (autoPublish && !autoAdvance) {
      send(res, 400, { error: 'Ative o avanço automático antes da publicação automática.' })
      return true
    }
    db.prepare('UPDATE organizations SET name=? WHERE id=?').run(
      String(body.organizationName).trim(),
      auth.organizationId,
    )
    db.prepare(
      `UPDATE organization_settings SET default_location=?,daily_limit=?,stuck_timeout_minutes=?,execution_interval_minutes=?,require_confirmation=?,description_template=?,auto_advance=?,fill_groups=?,target_groups=?,auto_publish=?,auto_retry=?,max_retries=?,alert_telegram_token=?,alert_telegram_chat_id=?,alert_webhook_url=?,auto_curate_groups=?,gemini_api_key=?,openai_api_key=?,ai_provider=?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=?`,
    ).run(
      String(body.defaultLocation || ''),
      limit,
      stuckTimeoutMinutes,
      executionIntervalMinutes,
      autoPublish ? 0 : 1,
      descriptionTemplate,
      autoAdvance ? 1 : 0,
      fillGroups ? 1 : 0,
      JSON.stringify(targetGroups),
      autoPublish ? 1 : 0,
      autoRetry ? 1 : 0,
      maxRetries,
      alertTelegramToken,
      alertTelegramChatId,
      alertWebhookUrl,
      autoCurateGroups ? 1 : 0,
      geminiApiKey,
      openaiApiKey,
      aiProvider,
      auth.organizationId,
    )
    const groups = replaceMarketplaceGroups(auth.organizationId, groupRecords)
    db.prepare(
      'UPDATE organization_settings SET autopilot_enabled=?,autopilot_interval_minutes=? WHERE organization_id=?',
    ).run(autopilotEnabled ? 1 : 0, autopilotIntervalMinutes, auth.organizationId)
    if (
      autopilotEnabled &&
      (!currentAutopilot.enabled || autopilotIntervalMinutes !== currentAutopilot.intervalMinutes)
    ) {
      db.prepare(
        'UPDATE autopilot_state SET next_run_at=CURRENT_TIMESTAMP WHERE organization_id=?',
      ).run(auth.organizationId)
    }
    send(res, 200, { ok: true, groups })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/team/users') {
    if (!isAdmin(auth)) {
      send(res, 403, { error: 'Somente administradores podem adicionar usuários.' })
      return true
    }
    const body = (await jsonBody(req)) as Record<string, unknown>
    if (!body.name || !body.email || !body.password) {
      send(res, 400, { error: 'Nome, e-mail e senha temporária são obrigatórios.' })
      return true
    }
    if (String(body.password).length < 8) {
      send(res, 400, { error: 'A senha temporária deve ter pelo menos 8 caracteres.' })
      return true
    }
    try {
      const passwordHash = await hashPassword(String(body.password))
      const result = db
        .prepare(
          'INSERT INTO users (organization_id,name,email,password_hash,role) VALUES (?,?,?,?,?)',
        )
        .run(
          auth.organizationId,
          String(body.name),
          String(body.email).toLowerCase(),
          passwordHash,
          body.role === 'admin' ? 'admin' : 'seller',
        )
      send(res, 201, { id: Number(result.lastInsertRowid) })
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        send(res, 409, { error: 'Este e-mail já está cadastrado.' })
        return true
      }
      throw error
    }
    return true
  }

  const teamUserRoute = url.pathname.match(/^\/api\/team\/users\/(\d+)$/)
  if (req.method === 'PATCH' && teamUserRoute) {
    if (!isAdmin(auth)) {
      send(res, 403, { error: 'Somente administradores podem alterar acessos.' })
      return true
    }
    const targetId = Number(teamUserRoute[1])
    const body = (await jsonBody(req)) as { active?: unknown }
    if (typeof body.active !== 'boolean') {
      send(res, 400, { error: 'Informe se o acesso deve ficar ativo.' })
      return true
    }
    if (targetId === auth.userId && !body.active) {
      send(res, 409, { error: 'Não é possível desativar o próprio acesso.' })
      return true
    }
    const target = db
      .prepare('SELECT id,role,active FROM users WHERE id=? AND organization_id=?')
      .get(targetId, auth.organizationId) as
      { id: number; role: string; active: number } | undefined
    if (!target) {
      send(res, 404, { error: 'Usuário não encontrado.' })
      return true
    }
    if (
      !body.active &&
      target.role === 'admin' &&
      Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) count FROM users WHERE organization_id=? AND role='admin' AND active=1",
            )
            .get(auth.organizationId) as { count: number }
        ).count,
      ) <= 1
    ) {
      send(res, 409, { error: 'A empresa precisa manter ao menos um administrador ativo.' })
      return true
    }
    db.exec('BEGIN')
    try {
      db.prepare('UPDATE users SET active=? WHERE id=? AND organization_id=?').run(
        body.active ? 1 : 0,
        targetId,
        auth.organizationId,
      )
      if (!body.active)
        db.prepare(
          'UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND revoked_at IS NULL',
        ).run(targetId)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    send(res, 200, { ok: true, active: body.active })
    return true
  }

  const accountAutomationRoute = url.pathname.match(/^\/api\/social-accounts\/(\d+)\/automation$/)
  if (req.method === 'PATCH' && accountAutomationRoute) {
    if (!isAdmin(auth)) {
      send(res, 403, { error: 'Somente administradores podem alterar a automação de perfis.' })
      return true
    }
    const accountId = Number(accountAutomationRoute[1])
    const account = db
      .prepare('SELECT id FROM social_accounts WHERE id=? AND organization_id=?')
      .get(accountId, auth.organizationId)
    if (!account) {
      send(res, 404, { error: 'Perfil de publicação não encontrado.' })
      return true
    }
    const body = (await jsonBody(req)) as Record<string, unknown>
    if (typeof body.paused !== 'boolean') {
      send(res, 400, { error: 'Informe se a automação deve ficar pausada.' })
      return true
    }
    if (body.paused) {
      const reason = String(body.reason || 'Pausa manual pelo administrador.')
        .trim()
        .slice(0, 500)
      db.prepare(
        `UPDATE social_accounts
          SET automation_paused=1,automation_pause_reason=?,automation_paused_at=CURRENT_TIMESTAMP
          WHERE id=? AND organization_id=?`,
      ).run(reason, accountId, auth.organizationId)
      send(res, 200, { ok: true, paused: true })
      return true
    }
    closeSelectorCircuitBreaker(db, auth.organizationId, accountId)
    send(res, 200, { ok: true, paused: false })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/social-accounts') {
    if (!isAdmin(auth)) {
      send(res, 403, { error: 'Somente administradores podem associar perfis do Brave.' })
      return true
    }
    const body = (await jsonBody(req)) as Record<string, unknown>
    const owner = db
      .prepare('SELECT id FROM users WHERE id=? AND organization_id=?')
      .get(Number(body.userId), auth.organizationId)
    if (!owner) {
      send(res, 400, { error: 'O responsável selecionado não pertence à empresa.' })
      return true
    }
    if (!body.label || !body.browserProfile) {
      send(res, 400, { error: 'Rótulo e perfil do Brave são obrigatórios.' })
      return true
    }
    const result = db
      .prepare(
        `INSERT INTO social_accounts (organization_id,user_id,label,browser_profile,status)
      VALUES (?,?,?,?, 'not_connected')`,
      )
      .run(
        auth.organizationId,
        Number(body.userId),
        String(body.label),
        String(body.browserProfile),
      )
    send(res, 201, { id: Number(result.lastInsertRowid) })
    return true
  }

  return false
}
