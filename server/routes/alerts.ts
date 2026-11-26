import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { clearAllCommanderMemory } from '../services/commander-memory.ts'
import { sendCriticalAlert } from '../services/alerting.ts'
import { getAlertCredentials } from '../services/credential-vault.ts'
import { commanderDiagnosticSettings, saveCommanderDiagnosticSettings } from '../services/commander-incident-diagnostics.ts'
import { telegramMonitorSettings, saveTelegramMonitorSettings } from '../services/telegram-monitor.ts'
import { telegramCommanderSettings, saveTelegramCommanderSettings } from '../services/telegram-commander.ts'

type AuthContext = { userId: number; organizationId: number }
type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  isAdmin: (auth: AuthContext) => boolean
  jsonBody: (req: IncomingMessage, maxBytes?: number) => Promise<unknown>
}

export async function handleAlertRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext,
  { db, send, isAdmin, jsonBody }: Dependencies,
): Promise<boolean> {
  if (url.pathname === '/api/alerts/commander-memory/clear' && req.method==='POST') {
    if(!isAdmin(auth)){send(res,403,{error:'Somente administradores podem limpar a memória da empresa.'});return true}
    const body=await jsonBody(req,4096) as {confirm?:unknown}|null
    if(body?.confirm!==true){send(res,400,{error:'Confirmação necessária.'});return true}
    res.setHeader('Cache-Control','no-store')
    send(res,200,{removed:clearAllCommanderMemory(db,auth.organizationId)})
    return true
  }
  if (url.pathname === '/api/alerts/commander-diagnostics' && ['GET','PATCH'].includes(req.method || '')) {
    if (!isAdmin(auth)) {send(res,403,{error:'Somente administradores podem configurar diagnósticos.'});return true}
    res.setHeader('Cache-Control','no-store')
    if (req.method==='GET') {send(res,200,commanderDiagnosticSettings(db,auth.organizationId));return true}
    const body=await jsonBody(req,4096)
    try{send(res,200,saveCommanderDiagnosticSettings(db,auth.organizationId,body))}
    catch{send(res,400,{error:'Confirme o grupo e a autorização de envio de evidências.'})}
    return true
  }
  if (url.pathname === '/api/alerts/telegram-commander' && ['GET','PATCH'].includes(req.method || '')) {
    if (!isAdmin(auth)) {send(res,403,{error:'Somente administradores podem configurar o receptor.'});return true}
    if (req.method==='GET') {send(res,200,telegramCommanderSettings(db,auth.organizationId));return true}
    const body=await jsonBody(req,4096)
    try{send(res,200,saveTelegramCommanderSettings(db,auth.organizationId,body))}
    catch{send(res,400,{error:'Configuração inválida, bot já utilizado ou grupo não confirmado.'})}
    return true
  }
  if (url.pathname === '/api/alerts/telegram-monitor' && ['GET','PATCH'].includes(req.method || '')) {
    if (!isAdmin(auth)) { send(res,403,{error:'Somente administradores podem configurar notificações.'}); return true }
    if (req.method==='GET') { send(res,200,telegramMonitorSettings(db,auth.organizationId)); return true }
    const body=await jsonBody(req,4096) as {categories?:unknown}|null
    try { send(res,200,saveTelegramMonitorSettings(db,auth.organizationId,body?.categories)) }
    catch { send(res,400,{error:'Não foi possível salvar as categorias de notificações.'}) }
    return true
  }
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
