import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { calculateOptimalSchedule } from '../services/smart-scheduler.ts'
import { findBestAccountForVehicle } from '../services/session-manager.ts'
import { publicationReadinessIssues } from '../services/publication-policy.ts'

type AuthContext = { userId: number; organizationId: number }
type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  jsonBody: (req: IncomingMessage) => Promise<unknown>
  userById: (id: number) => unknown
  canWriteVehicle: (vehicleId: number, auth: AuthContext) => boolean
  canManageJobs: (ids: number[], auth: AuthContext) => boolean
  jobsIncludeSoldVehicle: (ids: number[], organizationId: number) => boolean
  allowedExtensionAccount: (accountId: number, auth: AuthContext) => unknown
  publicationDuplicateRisk: (organizationId: number, vehicleId: number, excludeJobId?: number) => (Record<string, unknown> & { message: string }) | null
  recordJobEvent: (organizationId: number, jobId: number, eventType: string, createdBy?: number | null, details?: Record<string, unknown>, fromAccountId?: number | null, toAccountId?: number | null) => void
  refreshVehiclePublicationStatus: (vehicleId: number, organizationId: number) => void
}

const manualPublicationTransitions: Record<string, ReadonlySet<string>> = {
  pending: new Set(['canceled']),
  error: new Set(['pending', 'canceled']),
  awaiting_confirmation: new Set(['pending', 'completed', 'canceled']),
  completed: new Set(['removed']),
  filling: new Set(), canceled: new Set(), removed: new Set(),
}

export function isPublicationManagementRoute(req: IncomingMessage, url: URL) {
  if (req.method === 'POST' && url.pathname === '/api/publications') return true
  if (req.method === 'PATCH' && [
    '/api/publications/extension-visibility',
    '/api/publications/queue-state',
    '/api/publications/reassign',
    '/api/publications/schedule-batch',
  ].includes(url.pathname)) return true
  if (req.method !== 'PATCH') return false
  return /^\/api\/publications\/\d+$/.test(url.pathname)
    || /^\/api\/publications\/\d+\/(?:priority|schedule)$/.test(url.pathname)
}

export async function handlePublicationManagementRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext,
  dependencies: Dependencies,
): Promise<void> {
  const {
    db, send, jsonBody, userById, canWriteVehicle, canManageJobs,
    jobsIncludeSoldVehicle, allowedExtensionAccount, publicationDuplicateRisk,
    recordJobEvent, refreshVehiclePublicationStatus,
  } = dependencies
    if (req.method === 'POST' && url.pathname === '/api/publications') {
      const b = await jsonBody(req) as Record<string,unknown>
      const vehicle = db.prepare(`SELECT id,year,make,model,price,km,location,description,status,sold_at soldAt,vehicle_type vehicleType,
        transmission,fuel_type fuelType,body_type bodyType,exterior_color exteriorColor,interior_color interiorColor,vehicle_condition condition
        FROM vehicles WHERE id=? AND organization_id=?`).get(Number(b.vehicleId),auth.organizationId) as {id:number;year:number;make:string;model:string;price:number;km:number;status:string;soldAt:string|null;location:string;description:string;vehicleType:string;transmission:string;fuelType:string;bodyType:string;exteriorColor:string;interiorColor:string;condition:string}|undefined
      if (!vehicle) return send(res,400,{error:'Veículo inválido.'})
      if(vehicle.status==='Vendido'||vehicle.soldAt)return send(res,409,{error:'Veículos vendidos não podem ser publicados.'})
      if(!canWriteVehicle(vehicle.id,auth))return send(res,403,{error:'Você não pode publicar este veículo.'})
      const imageCount = (db.prepare('SELECT COUNT(*) c FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').get(vehicle.id,auth.organizationId) as {c:number}).c
      const missing = publicationReadinessIssues(vehicle, imageCount)
      if (missing.length) {
        db.prepare("UPDATE vehicles SET status='Atenção',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(vehicle.id,auth.organizationId)
        return send(res,422,{error:'Complete os dados obrigatórios antes de publicar.',missing})
      }
      let accountId=Number(b.accountId)
      if ((!b.accountId || b.accountId === 'auto' || b.autoAssign === true) && (!Number.isInteger(accountId) || accountId <= 0)) {
        const best = findBestAccountForVehicle(db, auth.organizationId, vehicle.id)
        if (best) accountId = best.id
      }
      if (!Number.isInteger(accountId)||!db.prepare('SELECT id FROM social_accounts WHERE id=? AND organization_id=?').get(accountId,auth.organizationId)) return send(res,400,{error:'Selecione o perfil do Brave que publicará este veículo.'})
      if(!allowedExtensionAccount(accountId,auth))return send(res,403,{error:'Você não pode criar trabalhos para este perfil.'})
      const duplicateRisk=publicationDuplicateRisk(auth.organizationId,vehicle.id)
      if(duplicateRisk)return send(res,409,{error:duplicateRisk.message,duplicate:duplicateRisk})
      const settings=db.prepare('SELECT daily_limit dailyLimit, max_retries maxRetries FROM organization_settings WHERE organization_id=?').get(auth.organizationId) as {dailyLimit:number;maxRetries?:number}|undefined
      const today=(db.prepare("SELECT COUNT(*) total FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND date(created_at,'localtime')=date('now','localtime') AND status!='canceled'").get(auth.organizationId,accountId) as {total:number}).total
      if(today>=Number(settings?.dailyLimit||10))return send(res,429,{error:`O perfil atingiu o limite diário de ${settings?.dailyLimit||10} trabalhos.`})
      const nextPriority=((db.prepare(`SELECT COALESCE(MAX(queue_priority),0)+1 value FROM publication_jobs
        WHERE organization_id=? AND social_account_id=? AND status IN ('pending','filling','error','awaiting_confirmation')`).get(auth.organizationId,accountId) as {value:number}).value)||1
      let scheduledAt:string|null=null
      if(String(b.scheduledAt||'').trim()){
        const timestamp=Date.parse(String(b.scheduledAt))
        if(!Number.isFinite(timestamp)||timestamp<Date.now()-60000)return send(res,400,{error:'Selecione uma data e hora futura para o agendamento.'})
        scheduledAt=new Date(timestamp).toISOString()
      } else if (b.smartSchedule === true) {
        const existing = db.prepare(`SELECT scheduled_at scheduledAt FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND scheduled_at IS NOT NULL AND datetime(scheduled_at)>CURRENT_TIMESTAMP`).all(auth.organizationId, accountId) as Array<{scheduledAt:string}>
        const existingTimestamps = existing.map(s => Date.parse(s.scheduledAt)).filter(Number.isFinite)
        const optimal = calculateOptimalSchedule({ existingTimestamps, accountId })
        scheduledAt = optimal.isoString
      }
      const maxRetries = Math.max(1, Math.min(10, Number(b.maxRetries) || Number(settings?.maxRetries) || 3))
      const result = db.prepare('INSERT INTO publication_jobs (organization_id,vehicle_id,social_account_id,status,queue_priority,scheduled_at,max_retries) VALUES (?,?,?,?,?,?,?)').run(auth.organizationId,Number(b.vehicleId),accountId,'pending',nextPriority,scheduledAt,maxRetries)
      recordJobEvent(auth.organizationId,Number(result.lastInsertRowid),'created',auth.userId,{accountId,scheduledAt,queuePriority:nextPriority,maxRetries,smartSchedule:Boolean(b.smartSchedule)})
      db.prepare("UPDATE vehicles SET status='Pronto',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(Number(b.vehicleId),auth.organizationId)
      return send(res,201,{id:Number(result.lastInsertRowid),accountId,scheduledAt})
    }
    if (req.method === 'PATCH' && url.pathname === '/api/publications/extension-visibility') {
      const b=await jsonBody(req) as Record<string,unknown>
      const ids=Array.isArray(b.ids)?[...new Set(b.ids.map(Number).filter(Number.isInteger))]:[]
      if(!ids.length)return send(res,400,{error:'Selecione pelo menos um trabalho.'})
      const placeholders=ids.map(()=>'?').join(',')
      const owned=db.prepare(`SELECT id FROM publication_jobs WHERE organization_id=? AND id IN (${placeholders})`).all(auth.organizationId,...ids) as Array<{id:number}>
      if(owned.length!==ids.length)return send(res,400,{error:'Um ou mais trabalhos não pertencem a esta empresa.'})
      if(!canManageJobs(ids,auth))return send(res,403,{error:'Você não pode alterar trabalhos de outro perfil.'})
      const visible=b.visible===true?1:0
      if(visible&&jobsIncludeSoldVehicle(ids,auth.organizationId))return send(res,409,{error:'Veículos vendidos não podem voltar à extensão.'})
      db.prepare(`UPDATE publication_jobs SET extension_visible=?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND id IN (${placeholders})`).run(visible,auth.organizationId,...ids)
      for(const id of ids)recordJobEvent(auth.organizationId,id,visible?'shown_in_extension':'hidden_from_extension',auth.userId)
      return send(res,200,{updated:ids.length,visible:Boolean(visible)})
    }
    if (req.method === 'PATCH' && url.pathname === '/api/publications/queue-state') {
      const b=await jsonBody(req) as Record<string,unknown>
      const ids=Array.isArray(b.ids)?[...new Set(b.ids.map(Number).filter(Number.isInteger))]:[]
      if(!ids.length)return send(res,400,{error:'Selecione pelo menos um trabalho.'})
      if(!['pause','resume'].includes(String(b.action)))return send(res,400,{error:'Ação de fila inválida.'})
      const placeholders=ids.map(()=>'?').join(',')
      const owned=db.prepare(`SELECT id,status FROM publication_jobs WHERE organization_id=? AND id IN (${placeholders})`).all(auth.organizationId,...ids) as Array<{id:number;status:string}>
      if(owned.length!==ids.length)return send(res,400,{error:'Um ou mais trabalhos não pertencem a esta empresa.'})
      if(!canManageJobs(ids,auth))return send(res,403,{error:'Você não pode alterar trabalhos de outro perfil.'})
      if(owned.some(job=>!['pending','error','awaiting_confirmation'].includes(job.status)))return send(res,409,{error:'Trabalhos em preenchimento ou encerrados não podem ser pausados.'})
      const paused=String(b.action)==='pause'?1:0
      if(!paused&&jobsIncludeSoldVehicle(ids,auth.organizationId))return send(res,409,{error:'Veículos vendidos não podem voltar à fila.'})
      if(paused)db.prepare(`UPDATE publication_jobs SET paused=1,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND id IN (${placeholders})`).run(auth.organizationId,...ids)
      else db.prepare(`UPDATE publication_jobs SET paused=0,extension_visible=1,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND id IN (${placeholders})`).run(auth.organizationId,...ids)
      for(const id of ids)recordJobEvent(auth.organizationId,id,paused?'paused':'resumed',auth.userId)
      return send(res,200,{updated:ids.length,paused:Boolean(paused)})
    }
    if (req.method === 'PATCH' && url.pathname === '/api/publications/reassign') {
      const currentUser=userById(auth.userId) as {role?:string}|undefined
      if(currentUser?.role!=='admin')return send(res,403,{error:'Somente administradores podem redistribuir trabalhos entre perfis.'})
      const b=await jsonBody(req) as Record<string,unknown>
      const ids=Array.isArray(b.ids)?[...new Set(b.ids.map(Number).filter(Number.isInteger))]:[]
      const accountId=Number(b.accountId)
      if(!ids.length)return send(res,400,{error:'Selecione pelo menos um trabalho.'})
      const target=db.prepare('SELECT id FROM social_accounts WHERE id=? AND organization_id=?').get(accountId,auth.organizationId)
      if(!target)return send(res,400,{error:'Selecione um perfil de destino válido.'})
      const placeholders=ids.map(()=>'?').join(',')
      const jobs=db.prepare(`SELECT id,vehicle_id vehicleId,social_account_id accountId,status,queue_priority priority FROM publication_jobs
        WHERE organization_id=? AND id IN (${placeholders}) ORDER BY queue_priority,id`).all(auth.organizationId,...ids) as Array<{id:number;vehicleId:number;accountId:number;status:string;priority:number}>
      if(jobs.length!==ids.length)return send(res,400,{error:'Um ou mais trabalhos não pertencem a esta empresa.'})
      if(jobs.some(job=>!['pending','error','awaiting_confirmation'].includes(job.status)))return send(res,409,{error:'Trabalhos em preenchimento ou encerrados não podem ser redistribuídos.'})
      if(jobs.some(job=>job.accountId===accountId))return send(res,400,{error:'Escolha um perfil diferente do perfil atual.'})
      if(jobsIncludeSoldVehicle(ids,auth.organizationId))return send(res,409,{error:'Trabalhos de veículos vendidos devem ser reconciliados no perfil original.'})
      const transferredVehicleIds=jobs.map(job=>job.vehicleId)
      const duplicatePlaceholders=transferredVehicleIds.map(()=>'?').join(',')
      const duplicate=db.prepare(`SELECT id FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND vehicle_id IN (${duplicatePlaceholders})
        AND status IN ('pending','filling','error','awaiting_confirmation') AND id NOT IN (${placeholders}) LIMIT 1`)
        .get(auth.organizationId,accountId,...transferredVehicleIds,...ids)
      if(duplicate)return send(res,409,{error:'O perfil de destino já possui um trabalho ativo para um dos veículos selecionados.'})
      const settings=db.prepare('SELECT daily_limit dailyLimit FROM organization_settings WHERE organization_id=?').get(auth.organizationId) as {dailyLimit:number}|undefined
      const today=(db.prepare("SELECT COUNT(*) total FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND date(created_at,'localtime')=date('now','localtime') AND status!='canceled'").get(auth.organizationId,accountId) as {total:number}).total
      if(today+jobs.length>Number(settings?.dailyLimit||10))return send(res,429,{error:`A transferência ultrapassaria o limite diário de ${settings?.dailyLimit||10} trabalhos do perfil de destino.`})
      let nextPriority=((db.prepare(`SELECT COALESCE(MAX(queue_priority),0)+1 value FROM publication_jobs WHERE organization_id=? AND social_account_id=?
        AND status IN ('pending','filling','error','awaiting_confirmation')`).get(auth.organizationId,accountId) as {value:number}).value)||1
      db.exec('BEGIN')
      try{
        for(const job of jobs){
          db.prepare(`UPDATE publication_jobs SET social_account_id=?,queue_priority=?,extension_visible=1,paused=0,updated_at=CURRENT_TIMESTAMP
            WHERE id=? AND organization_id=?`).run(accountId,nextPriority++,job.id,auth.organizationId)
          recordJobEvent(auth.organizationId,job.id,'reassigned',auth.userId,{queuePriority:nextPriority-1},job.accountId,accountId)
        }
        db.exec('COMMIT')
      }catch(error){db.exec('ROLLBACK');throw error}
      return send(res,200,{updated:jobs.length,accountId})
    }
    const queuePriority=url.pathname.match(/^\/api\/publications\/(\d+)\/priority$/)
    if(req.method==='PATCH'&&queuePriority){
      const b=await jsonBody(req) as Record<string,unknown>,direction=String(b.direction)
      if(!['up','down'].includes(direction))return send(res,400,{error:'Direção inválida.'})
      const current=db.prepare(`SELECT id,social_account_id accountId,queue_priority priority,status FROM publication_jobs
        WHERE id=? AND organization_id=?`).get(Number(queuePriority[1]),auth.organizationId) as {id:number;accountId:number;priority:number;status:string}|undefined
      if(!current)return send(res,404,{error:'Trabalho não encontrado.'})
      if(!canManageJobs([current.id],auth))return send(res,403,{error:'Você não pode alterar trabalhos de outro perfil.'})
      if(!['pending','error','awaiting_confirmation'].includes(current.status))return send(res,409,{error:'Este trabalho não pode ser reordenado agora.'})
      const comparator=direction==='up'?'<':'>'
      const order=direction==='up'?'DESC':'ASC'
      const neighbor=db.prepare(`SELECT id,queue_priority priority FROM publication_jobs WHERE organization_id=? AND social_account_id=?
        AND status IN ('pending','error','awaiting_confirmation') AND queue_priority ${comparator} ? ORDER BY queue_priority ${order},id ${order} LIMIT 1`)
        .get(auth.organizationId,current.accountId,current.priority) as {id:number;priority:number}|undefined
      if(!neighbor)return send(res,200,{ok:true,moved:false})
      db.exec('BEGIN')
      try{
        db.prepare('UPDATE publication_jobs SET queue_priority=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(neighbor.priority,current.id,auth.organizationId)
        db.prepare('UPDATE publication_jobs SET queue_priority=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(current.priority,neighbor.id,auth.organizationId)
        recordJobEvent(auth.organizationId,current.id,'priority_changed',auth.userId,{direction,from:current.priority,to:neighbor.priority})
        db.exec('COMMIT')
      }catch(error){db.exec('ROLLBACK');throw error}
      return send(res,200,{ok:true,moved:true})
    }
    const publicationSchedule=url.pathname.match(/^\/api\/publications\/(\d+)\/schedule$/)
    if(req.method==='PATCH'&&publicationSchedule){
      const b=await jsonBody(req) as Record<string,unknown>
      const job=db.prepare('SELECT id,status FROM publication_jobs WHERE id=? AND organization_id=?').get(Number(publicationSchedule[1]),auth.organizationId) as {id:number;status:string}|undefined
      if(!job)return send(res,404,{error:'Trabalho não encontrado.'})
      if(!canManageJobs([job.id],auth))return send(res,403,{error:'Você não pode alterar trabalhos de outro perfil.'})
      if(!['pending','error','awaiting_confirmation'].includes(job.status))return send(res,409,{error:'Este trabalho não pode ser agendado agora.'})
      let scheduledAt:string|null=null
      if(String(b.scheduledAt||'').trim()){
        const timestamp=Date.parse(String(b.scheduledAt))
        if(!Number.isFinite(timestamp)||timestamp<Date.now()+60000)return send(res,400,{error:'Escolha um horário com pelo menos um minuto de antecedência.'})
        scheduledAt=new Date(timestamp).toISOString()
      }
      db.prepare('UPDATE publication_jobs SET scheduled_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(scheduledAt,job.id,auth.organizationId)
      recordJobEvent(auth.organizationId,job.id,scheduledAt?'scheduled':'schedule_removed',auth.userId,{scheduledAt})
      return send(res,200,{ok:true,scheduledAt})
    }
    if(req.method==='PATCH'&&url.pathname==='/api/publications/schedule-batch'){
      const b=await jsonBody(req) as Record<string,unknown>
      const ids=Array.isArray(b.ids)?[...new Set(b.ids.map(Number).filter(Number.isInteger))].slice(0,50):[]
      if(ids.length<2)return send(res,400,{error:'Selecione pelo menos dois trabalhos para criar uma sequência.'})
      const startTimestamp=Date.parse(String(b.startAt||'')),intervalMinutes=Math.floor(Number(b.intervalMinutes))
      if(!Number.isFinite(startTimestamp)||startTimestamp<Date.now()+60000)return send(res,400,{error:'Escolha um primeiro horário com pelo menos um minuto de antecedência.'})
      if(!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>1440)return send(res,400,{error:'O intervalo deve ficar entre 1 minuto e 24 horas.'})
      const placeholders=ids.map(()=>'?').join(',')
      const rows=db.prepare(`SELECT id,status,social_account_id accountId FROM publication_jobs WHERE organization_id=? AND id IN (${placeholders})`).all(auth.organizationId,...ids) as Array<{id:number;status:string;accountId:number}>
      if(rows.length!==ids.length)return send(res,400,{error:'Um ou mais trabalhos não pertencem a esta empresa.'})
      if(!canManageJobs(ids,auth))return send(res,403,{error:'Você não pode alterar trabalhos de outro perfil.'})
      if(rows.some(job=>!['pending','error','awaiting_confirmation'].includes(job.status)))return send(res,409,{error:'Trabalhos em preenchimento ou encerrados não podem ser agendados.'})
      const byId=new Map(rows.map(job=>[job.id,job])),intervalMs=intervalMinutes*60000
      const existing=db.prepare(`SELECT social_account_id accountId,scheduled_at scheduledAt FROM publication_jobs WHERE organization_id=? AND scheduled_at IS NOT NULL
        AND datetime(scheduled_at)>CURRENT_TIMESTAMP AND id NOT IN (${placeholders}) AND status IN ('pending','error','awaiting_confirmation')`).all(auth.organizationId,...ids) as Array<{accountId:number;scheduledAt:string}>
      const occupied=new Map<number,number[]>()
      for(const item of existing){const timestamp=Date.parse(item.scheduledAt);if(Number.isFinite(timestamp))occupied.set(item.accountId,[...(occupied.get(item.accountId)||[]),timestamp])}
      const assignments=ids.map((id,index)=>{
        const job=byId.get(id)!,profileTimes=occupied.get(job.accountId)||[]
        let timestamp=startTimestamp+index*intervalMs
        while(profileTimes.some(value=>Math.abs(value-timestamp)<intervalMs))timestamp+=intervalMs
        profileTimes.push(timestamp);occupied.set(job.accountId,profileTimes)
        return{id,accountId:job.accountId,scheduledAt:new Date(timestamp).toISOString(),position:index+1}
      })
      db.exec('BEGIN')
      try{
        for(const assignment of assignments){
          db.prepare('UPDATE publication_jobs SET scheduled_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(assignment.scheduledAt,assignment.id,auth.organizationId)
          recordJobEvent(auth.organizationId,assignment.id,'batch_scheduled',auth.userId,{scheduledAt:assignment.scheduledAt,intervalMinutes,position:assignment.position,total:assignments.length})
        }
        db.exec('COMMIT')
      }catch(error){db.exec('ROLLBACK');throw error}
      return send(res,200,{ok:true,updated:assignments.length,intervalMinutes,assignments})
    }
    const publication = url.pathname.match(/^\/api\/publications\/(\d+)$/)
    if (req.method === 'PATCH' && publication) {
      const b = await jsonBody(req) as Record<string,unknown>
      const allowed = ['pending','filling','awaiting_confirmation','completed','error','canceled','removed']
      if (!allowed.includes(String(b.status))) return send(res,400,{error:'Status inválido.'})
      const job=db.prepare('SELECT vehicle_id vehicleId,status,fill_report fillReport FROM publication_jobs WHERE id=? AND organization_id=?').get(Number(publication[1]),auth.organizationId) as {vehicleId:number;status:string;fillReport?:string}|undefined
      if(!job)return send(res,404,{error:'Publicação não encontrada.'})
      if(!canManageJobs([Number(publication[1])],auth))return send(res,403,{error:'Você não pode alterar trabalhos de outro perfil.'})
      const nextStatus=String(b.status)
      if(nextStatus==='pending'&&jobsIncludeSoldVehicle([Number(publication[1])],auth.organizationId))return send(res,409,{error:'Veículos vendidos não podem voltar à fila.'})
      if(!manualPublicationTransitions[job.status]?.has(nextStatus))return send(res,409,{error:`A transição de ${job.status} para ${nextStatus} não é permitida por esta operação.`})
      let previousReport:Record<string,unknown>={}
      try{previousReport=job.fillReport?JSON.parse(job.fillReport):{}}catch{/* relatório antigo inválido */}
      if(nextStatus==='pending'&&previousReport.publishAttempted&&b.confirmNoPublication!==true)return send(res,409,{error:'Antes de repetir, verifique em “Seus classificados” se o anúncio foi criado. Confirme no painel que ele NÃO foi publicado para liberar uma nova tentativa.'})
      db.exec('BEGIN')
      try{
        if(nextStatus==='pending')db.prepare("UPDATE publication_jobs SET status='pending',paused=0,extension_visible=1,error_code=NULL,fill_report='',started_at=NULL,filled_at=NULL,removed_at=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(Number(publication[1]),auth.organizationId)
        else if(nextStatus==='removed')db.prepare("UPDATE publication_jobs SET status='removed',removed_at=CURRENT_TIMESTAMP,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(Number(publication[1]),auth.organizationId)
        else db.prepare('UPDATE publication_jobs SET status=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(nextStatus,Number(publication[1]),auth.organizationId)
        if(nextStatus==='completed'||nextStatus==='removed')refreshVehiclePublicationStatus(job.vehicleId,auth.organizationId)
        const eventType:Record<string,string>={pending:'retry_requested',filling:'filling_started',awaiting_confirmation:'filled_waiting_confirmation',completed:'confirmed_published',error:'fill_error',canceled:'canceled',removed:'marked_removed'}
        recordJobEvent(auth.organizationId,Number(publication[1]),eventType[nextStatus]||'status_changed',auth.userId,{status:nextStatus})
        db.exec('COMMIT')
      }catch(error){db.exec('ROLLBACK');throw error}
      return send(res,200,{ok:true})
    }
  return;
}
