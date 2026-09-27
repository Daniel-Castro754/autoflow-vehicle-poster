import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { publicationMayExist, readPublicationReport } from '../services/publication-evidence.ts'
import { findBestAccountForVehicle } from '../services/session-manager.ts'
import { calculateBackoff } from '../lib/retry.ts'
import { isRetryableExtensionFailureCode } from '../services/publication-policy.ts'
import { sendCriticalAlert } from '../services/alerting.ts'

type AuthContext = { userId: number; organizationId: number }
type Group = { id: number; name: string; groupKey: string; url: string }
type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  jsonBody: (req: IncomingMessage, maxBytes?: number) => Promise<unknown>
  userById: (id: number) => unknown
  allowedExtensionAccount: (accountId: number, auth: AuthContext) => unknown
  marketplaceGroups: (organizationId: number, activeOnly?: boolean) => Group[]
  groupTarget: (group: Pick<Group, 'name' | 'url'>) => string
  jobsIncludeSoldVehicle: (ids: number[], organizationId: number) => boolean
  publicationDuplicateRisk: (organizationId: number, vehicleId: number, excludeJobId?: number) => (Record<string, unknown> & { message: string }) | null
  recordJobEvent: (organizationId: number, jobId: number, eventType: string, createdBy?: number | null, details?: Record<string, unknown>, fromAccountId?: number | null, toAccountId?: number | null) => void
  refreshVehiclePublicationStatus: (vehicleId: number, organizationId: number) => void
  parseGroupTarget: (value: unknown) => { name: string; groupKey: string; url: string }
  imageBaseUrl: string
}

export function isExtensionRoute(req: IncomingMessage, url: URL) {
  if (req.method === 'GET' && ['/api/extension/accounts', '/api/extension/queue'].includes(url.pathname)) return true
  const routes: Record<string, string[]> = {
    POST: ['prepare', 'bind-document', 'publish-check', 'publish-started', 'heartbeat', 'publish-not-clicked'],
    PATCH: ['fill-result'],
  }
  return Boolean(routes[req.method || '']?.some(action => new RegExp(`^/api/extension/jobs/\\d+/${action}$`).test(url.pathname)))
}

export async function handleExtensionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext,
  {
    db, send, jsonBody, userById, allowedExtensionAccount, marketplaceGroups, groupTarget,
    jobsIncludeSoldVehicle, publicationDuplicateRisk, recordJobEvent,
    refreshVehiclePublicationStatus, parseGroupTarget, imageBaseUrl,
  }: Dependencies,
): Promise<void> {
    if (req.method === 'GET' && url.pathname === '/api/extension/accounts') {
      const current = userById(auth.userId) as {role?:string}|undefined
      const accounts = current?.role==='admin'
        ? db.prepare(`SELECT a.id,a.label,a.browser_profile browserProfile,a.status,a.user_id userId,u.name owner
            FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.organization_id=? ORDER BY u.name,a.label`).all(auth.organizationId)
        : db.prepare(`SELECT a.id,a.label,a.browser_profile browserProfile,a.status,a.user_id userId,u.name owner
            FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.organization_id=? AND a.user_id=? ORDER BY a.label`).all(auth.organizationId,auth.userId)
      return send(res,200,{accounts})
    }
    if (req.method === 'GET' && url.pathname === '/api/extension/queue') {
      const accountId=Number(url.searchParams.get('accountId'))
      const account=allowedExtensionAccount(accountId,auth)
      if (!account) return send(res,403,{error:'Selecione um perfil do Brave associado a este usuário.'})
      db.prepare('UPDATE social_accounts SET last_seen_at=CURRENT_TIMESTAMP,status=? WHERE id=? AND organization_id=?').run('connected',accountId,auth.organizationId)
      const jobs = db.prepare(`SELECT j.id jobId,j.vehicle_id vehicleId,j.status jobStatus,j.error_code errorCode,j.fill_report fillReport,j.queue_priority queuePriority,j.scheduled_at scheduledAt,j.updated_at updatedAt,
        CASE WHEN j.lease_expires_at IS NOT NULL AND datetime(j.lease_expires_at)>CURRENT_TIMESTAMP THEN 1 ELSE 0 END locked,
        v.year,v.make,v.model,v.trim,v.price,v.km,v.status vehicleStatus,
        (SELECT COUNT(*) FROM vehicle_images i WHERE i.vehicle_id=v.id) imageCount,
        COALESCE(u.name,'Não atribuído') seller,a.label accountLabel
        FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id
        JOIN social_accounts a ON a.id=j.social_account_id LEFT JOIN users u ON u.id=v.assigned_user_id
        WHERE j.organization_id=? AND j.social_account_id=? AND v.status!='Vendido' AND v.sold_at IS NULL AND j.extension_visible=1 AND j.paused=0 AND (j.scheduled_at IS NULL OR datetime(j.scheduled_at)<=CURRENT_TIMESTAMP) AND j.status IN ('pending','filling','error','awaiting_confirmation')
        ORDER BY CASE j.status WHEN 'filling' THEN 0 ELSE 1 END,j.queue_priority,j.created_at`).all(auth.organizationId,accountId) as Array<Record<string,unknown>>
      for(const job of jobs){
        let report:Record<string,unknown>={}
        try{report=JSON.parse(String(job.fillReport||'{}'))}catch{/* relatório antigo */}
        job.publishUncertain=report.publishAttempted===true&&report.published!==true&&report.publishNotClicked!==true
        delete job.fillReport
      }
      const settings=db.prepare(`SELECT auto_advance autoAdvance,fill_groups fillGroups,target_groups targetGroups,auto_publish autoPublish
        FROM organization_settings WHERE organization_id=?`).get(auth.organizationId) as Record<string,unknown>|undefined
      let targetGroups:string[]=[]
      try { const parsed=JSON.parse(String(settings?.targetGroups||'[]')); if(Array.isArray(parsed))targetGroups=parsed.map(String) } catch { /* lista antiga inválida */ }
      const configuredGroups=marketplaceGroups(auth.organizationId,true)
      if(configuredGroups.length)targetGroups=configuredGroups.map(groupTarget)
      const nextScheduledAt=(db.prepare(`SELECT MIN(scheduled_at) scheduledAt FROM publication_jobs
        WHERE organization_id=? AND social_account_id=? AND extension_visible=1 AND paused=0
          AND status='pending' AND scheduled_at IS NOT NULL AND datetime(scheduled_at)>CURRENT_TIMESTAMP
          AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.id=publication_jobs.vehicle_id AND (v.status='Vendido' OR v.sold_at IS NOT NULL))`)
        .get(auth.organizationId,accountId) as {scheduledAt?:string|null}).scheduledAt
      return send(res,200,{account,jobs,nextScheduledAt,automation:{autoAdvance:Boolean(settings?.autoAdvance),fillGroups:Boolean(settings?.fillGroups),targetGroups,autoPublish:Boolean(settings?.autoPublish)}})
    }
    const extensionPrepare = url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/prepare$/)
    if (req.method === 'POST' && extensionPrepare) {
      const b=await jsonBody(req) as {accountId?:number;instanceId?:string;tabId?:number;document?:string}
      const accountId=Number(b.accountId)
      const instanceId=String(b.instanceId||'').trim().slice(0,100)
      const tabId=Number(b.tabId),document=String(b.document||'').trim().slice(0,200)
      if(!/^[a-zA-Z0-9_-]{12,100}$/.test(instanceId))return send(res,400,{error:'A extensão precisa atualizar sua identificação local antes de iniciar.'})
      if(!Number.isInteger(tabId)||tabId<1||!/^\/marketplace\/create\/vehicle\/?$/.test(document))return send(res,400,{error:'A aba de execução precisa estar no formulário de veículo do Marketplace.'})
      if (!allowedExtensionAccount(accountId,auth)) return send(res,403,{error:'Este perfil do Brave não está disponível para o usuário conectado.'})
      const job = db.prepare(`SELECT j.id,j.vehicle_id vehicleId,j.status,j.paused,j.scheduled_at scheduledAt,j.lease_expires_at leaseExpiresAt,j.fill_report fillReport,j.publish_attempt_at publishAttemptAt FROM publication_jobs j
        WHERE j.id=? AND j.organization_id=? AND j.social_account_id=?`).get(Number(extensionPrepare[1]),auth.organizationId,accountId) as {id:number;vehicleId:number;status:string;paused:number;scheduledAt?:string;leaseExpiresAt?:string;fillReport?:string;publishAttemptAt?:string}|undefined
      if (!job) return send(res,404,{error:'Trabalho não encontrado para este perfil.'})
      if(jobsIncludeSoldVehicle([job.id],auth.organizationId))return send(res,409,{error:'Veículos vendidos não podem ser publicados.'})
      if (job.paused) return send(res,409,{error:'Este trabalho está pausado no painel.'})
      if (job.scheduledAt&&Date.parse(job.scheduledAt)>Date.now()) return send(res,409,{error:'Este trabalho ainda não chegou ao horário agendado.'})
      if (!['pending','filling','error','awaiting_confirmation'].includes(job.status)) return send(res,409,{error:'Este trabalho não está disponível para preenchimento.'})
      if(job.leaseExpiresAt&&Date.parse(job.leaseExpiresAt.replace(' ','T')+'Z')>Date.now())return send(res,409,{error:'Este trabalho já está aberto em outra aba ou instância da extensão.'})
      if(publicationMayExist(job))return send(res,409,{error:'Esta execução pode já ter publicado o anúncio. Reconcilie o resultado antes de iniciar outra tentativa.'})
      const executionSettings=db.prepare(`SELECT daily_limit dailyLimit,execution_interval_minutes executionIntervalMinutes
        FROM organization_settings WHERE organization_id=?`).get(auth.organizationId) as {dailyLimit?:number;executionIntervalMinutes?:number}|undefined
      const dailyLimit=Math.max(1,Number(executionSettings?.dailyLimit||10))
      const intervalMinutes=Math.max(0,Math.min(1440,Number(executionSettings?.executionIntervalMinutes??25)))
      const usage=db.prepare(`SELECT COUNT(*) count,MAX(CASE WHEN status IN ('completed','removed') THEN updated_at END) lastCompletedAt
        FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND autoflow_day(created_at)=autoflow_day(CURRENT_TIMESTAMP) AND status!='canceled'`)
        .get(auth.organizationId,accountId) as {count?:number;lastCompletedAt?:string|null}|undefined
      if(Number(usage?.count||0)>=dailyLimit)return send(res,409,{error:`O limite diário deste perfil foi atingido (${dailyLimit} execuções).`,capacity:{dailyLimit,used:Number(usage?.count||0),remaining:0}})
      if(intervalMinutes>0&&usage?.lastCompletedAt){
        const elapsed=Date.now()-Date.parse(String(usage.lastCompletedAt).replace(' ','T')+'Z')
        if(Number.isFinite(elapsed)&&elapsed<intervalMinutes*60000){
          const retryAfterSeconds=Math.ceil((intervalMinutes*60000-elapsed)/1000)
          return send(res,409,{error:`Aguarde ${Math.ceil(retryAfterSeconds/60)} min antes de iniciar outra execução neste perfil.`,capacity:{dailyLimit,used:Number(usage?.count||0),remaining:Math.max(0,dailyLimit-Number(usage?.count||0)),intervalMinutes,retryAfterSeconds}})
        }
      }
      let previousReport:Record<string,unknown>={}
      try{previousReport=job.fillReport?JSON.parse(job.fillReport):{}}catch{/* relatório antigo inválido */}
      if(previousReport.publishAttempted&&!previousReport.published&&previousReport.publishNotClicked!==true)return send(res,409,{error:'O Facebook recebeu um clique em Publicar, mas não confirmou o resultado. Verifique Seus classificados e confirme no painel antes de tentar novamente.'})
      const duplicateRisk=publicationDuplicateRisk(auth.organizationId,job.vehicleId,job.id)
      if(duplicateRisk){recordJobEvent(auth.organizationId,job.id,'duplicate_blocked',null,duplicateRisk);return send(res,409,{error:duplicateRisk.message,duplicate:duplicateRisk})}
      const vehicle = db.prepare(`SELECT v.id,v.year,v.make,v.model,v.trim,v.price,v.km,v.status,
        v.vehicle_type vehicleType,v.location,v.transmission,v.fuel_type fuelType,v.body_type bodyType,v.exterior_color exteriorColor,v.interior_color interiorColor,v.vehicle_condition condition,
        printf('%d %s %s %s',v.year,v.make,v.model,v.trim) title,
        CASE WHEN length(v.description)>0 THEN v.description ELSE printf('%d %s %s %s com %d km. Entre em contato para consultar disponibilidade e condições.',v.year,v.make,v.model,v.trim,v.km) END description
        FROM vehicles v WHERE v.id=? AND v.organization_id=?`).get(job.vehicleId,auth.organizationId) as Record<string,unknown>|undefined
      if (!vehicle) return send(res,404,{error:'Veículo não encontrado.'})
      const images = db.prepare(`SELECT ?||file_name url,original_name name,mime_type mimeType FROM vehicle_images WHERE vehicle_id=? AND organization_id=? ORDER BY position,id LIMIT 20`).all(imageBaseUrl,job.vehicleId,auth.organizationId)
      const settings=db.prepare(`SELECT auto_advance autoAdvance,fill_groups fillGroups,target_groups targetGroups,auto_publish autoPublish
        FROM organization_settings WHERE organization_id=?`).get(auth.organizationId) as Record<string,unknown>|undefined
      let targetGroups:string[]=[]
      try { const parsed=JSON.parse(String(settings?.targetGroups||'[]')); if(Array.isArray(parsed))targetGroups=parsed.map(String) } catch { /* lista antiga inválida */ }
      const configuredGroups=marketplaceGroups(auth.organizationId,true)
      if(configuredGroups.length)targetGroups=configuredGroups.map(groupTarget)
      const leaseToken=randomBytes(24).toString('hex'),leaseSeconds=120
      const acquired=db.prepare(`UPDATE publication_jobs SET status='filling',attempt_count=attempt_count+1,error_code=NULL,started_at=CURRENT_TIMESTAMP,
        lease_token=?,lease_owner=?,execution_tab_id=?,execution_document=?,execution_document_id=NULL,lease_expires_at=datetime('now',?),updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?
        AND social_account_id=? AND paused=0 AND publish_attempt_at IS NULL AND status IN ('pending','filling','error','awaiting_confirmation')
        AND (scheduled_at IS NULL OR datetime(scheduled_at)<=CURRENT_TIMESTAMP)
        AND (lease_expires_at IS NULL OR datetime(lease_expires_at)<=CURRENT_TIMESTAMP)
        AND NOT EXISTS (SELECT 1 FROM publication_jobs active WHERE active.organization_id=? AND active.id<>? AND active.status='filling'
          AND datetime(active.lease_expires_at)>CURRENT_TIMESTAMP AND (active.social_account_id=? OR active.lease_owner=?))`).run(leaseToken,instanceId,tabId,document,`+${leaseSeconds} seconds`,job.id,auth.organizationId,accountId,auth.organizationId,job.id,accountId,instanceId)
      if(!acquired.changes)return send(res,409,{error:'Este trabalho acabou de ser aberto por outra aba ou instância.'})
      recordJobEvent(auth.organizationId,job.id,'filling_started',null,{accountId,instanceId})
      return send(res,200,{jobId:job.id,accountId,leaseToken,leaseSeconds,tabId,document,vehicle:{...vehicle,images},automation:{autoAdvance:Boolean(settings?.autoAdvance),fillGroups:Boolean(settings?.fillGroups),targetGroups,autoPublish:Boolean(settings?.autoPublish)}})
    }
    const bindExecutionDocument=url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/bind-document$/)
    if(req.method==='POST'&&bindExecutionDocument){
      const b=await jsonBody(req) as Record<string,unknown>
      const documentId=String(b.documentId||'').trim().slice(0,200)
      if(!/^[a-zA-Z0-9_-]{8,200}$/.test(documentId))return send(res,400,{error:'O documento do Marketplace não foi identificado.'})
      const job=db.prepare(`SELECT social_account_id accountId,lease_token leaseToken,lease_expires_at leaseExpiresAt,
        execution_tab_id executionTabId,execution_document executionDocument,execution_document_id executionDocumentId
        FROM publication_jobs WHERE id=? AND organization_id=? AND status='filling' AND paused=0`).get(Number(bindExecutionDocument[1]),auth.organizationId) as {
          accountId:number;leaseToken?:string;leaseExpiresAt?:string;executionTabId?:number;executionDocument?:string;executionDocumentId?:string
        }|undefined
      if(!job||!allowedExtensionAccount(job.accountId,auth)||job.leaseToken!==String(b.leaseToken||'')
        ||Number(job.executionTabId)!==Number(b.tabId)||String(job.executionDocument)!==String(b.document||'')
        ||!job.leaseExpiresAt||Date.parse(job.leaseExpiresAt.replace(' ','T')+'Z')<=Date.now())return send(res,409,{error:'A execução perdeu o bloqueio exclusivo.'})
      if(job.executionDocumentId&&job.executionDocumentId!==documentId)recordJobEvent(auth.organizationId,Number(bindExecutionDocument[1]),'execution_document_rebound',null,{tabId:job.executionTabId})
      db.prepare(`UPDATE publication_jobs SET execution_document_id=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND organization_id=? AND lease_token=? AND execution_tab_id=? AND execution_document=?`)
        .run(documentId,Number(bindExecutionDocument[1]),auth.organizationId,String(b.leaseToken||''),Number(b.tabId),String(b.document||''))
      return send(res,200,{ok:true,documentId})
    }
    const publishCheck=url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/publish-check$/)
    if(req.method==='POST'&&publishCheck){
      const b=await jsonBody(req) as Record<string,unknown>
      const job=db.prepare(`SELECT id,social_account_id accountId,execution_tab_id executionTabId,execution_document executionDocument,execution_document_id executionDocumentId FROM publication_jobs
        WHERE id=? AND organization_id=? AND status='filling' AND paused=0 AND extension_visible=1
        AND lease_token=? AND execution_tab_id=? AND execution_document=? AND execution_document_id=? AND datetime(lease_expires_at)>CURRENT_TIMESTAMP`).get(Number(publishCheck[1]),auth.organizationId,String(b.leaseToken||''),Number(b.tabId),String(b.document||''),String(b.documentId||'')) as {id:number;accountId:number;executionTabId:number;executionDocument:string;executionDocumentId:string}|undefined
      if(!job||!allowedExtensionAccount(job.accountId,auth))return send(res,409,{error:'Esta execução não está mais autorizada a publicar nesta aba.'})
      if(jobsIncludeSoldVehicle([job.id],auth.organizationId))return send(res,409,{error:'O veículo foi vendido. A publicação foi interrompida.'})
      return send(res,200,{ok:true})
    }
    const publishStarted=url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/publish-started$/)
    if(req.method==='POST'&&publishStarted){
      const b=await jsonBody(req) as Record<string,unknown>
      const job=db.prepare(`SELECT j.id,j.social_account_id accountId,j.lease_token leaseToken,j.lease_expires_at leaseExpiresAt,j.execution_tab_id executionTabId,j.execution_document executionDocument,j.execution_document_id executionDocumentId,j.fill_report fillReport
        FROM publication_jobs j WHERE j.id=? AND j.organization_id=? AND j.status='filling'`).get(Number(publishStarted[1]),auth.organizationId) as {id:number;accountId:number;leaseToken?:string;leaseExpiresAt?:string;executionTabId?:number;executionDocument?:string;executionDocumentId?:string;fillReport?:string}|undefined
      if(!job||!allowedExtensionAccount(job.accountId,auth)||job.leaseToken!==String(b.leaseToken||'')||Number(job.executionTabId)!==Number(b.tabId)||String(job.executionDocument)!==String(b.document||'')||String(job.executionDocumentId)!==String(b.documentId||'')||!job.leaseExpiresAt||Date.parse(job.leaseExpiresAt.replace(' ','T')+'Z')<=Date.now())return send(res,409,{error:'A execução perdeu o bloqueio exclusivo.'})
      if(jobsIncludeSoldVehicle([job.id],auth.organizationId))return send(res,409,{error:'O veículo foi vendido. A publicação foi interrompida.'})
      let report:Record<string,unknown>={}
      try{report=job.fillReport?JSON.parse(job.fillReport):{}}catch{/* relatório legado inválido */}
      const incoming=(b.report&&typeof b.report==='object'?b.report:{}) as Record<string,unknown>
      const nextReport={...report,...incoming,publishAttempted:true,publishNotClicked:false,publishPhase:'click_pending',published:false}
      db.prepare('UPDATE publication_jobs SET fill_report=?,publish_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?')
        .run(JSON.stringify(nextReport),job.id,auth.organizationId)
      recordJobEvent(auth.organizationId,job.id,'publish_attempted',null,{publishAttempted:true})
      return send(res,200,{ok:true})
    }
    const extensionHeartbeat=url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/heartbeat$/)
    if(req.method==='POST'&&extensionHeartbeat){
      const b=await jsonBody(req) as Record<string,unknown>,leaseToken=String(b.leaseToken||''),tabId=Number(b.tabId),document=String(b.document||''),documentId=String(b.documentId||'')
      const updated=db.prepare(`UPDATE publication_jobs SET lease_expires_at=datetime('now','+120 seconds'),updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND organization_id=? AND status='filling' AND lease_token=? AND execution_tab_id=? AND execution_document=? AND execution_document_id=? AND datetime(lease_expires_at)>CURRENT_TIMESTAMP
        AND EXISTS (SELECT 1 FROM vehicles v WHERE v.id=publication_jobs.vehicle_id AND v.status!='Vendido' AND v.sold_at IS NULL)`).run(Number(extensionHeartbeat[1]),auth.organizationId,leaseToken,tabId,document,documentId)
      if(!updated.changes)return send(res,409,{error:'O bloqueio desta execução expirou ou pertence a outra instância.'})
      return send(res,200,{ok:true,leaseSeconds:120})
    }
    const publishNotClicked=url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/publish-not-clicked$/)
    if(req.method==='POST'&&publishNotClicked){
      const b=await jsonBody(req) as Record<string,unknown>
      const job=db.prepare(`SELECT id,social_account_id accountId,lease_token leaseToken,lease_expires_at leaseExpiresAt,
        execution_tab_id executionTabId,execution_document executionDocument,execution_document_id executionDocumentId,fill_report fillReport
        FROM publication_jobs WHERE id=? AND organization_id=? AND status='filling'`).get(Number(publishNotClicked[1]),auth.organizationId) as {
          id:number;accountId:number;leaseToken?:string;leaseExpiresAt?:string;executionTabId?:number;executionDocument?:string;executionDocumentId?:string;fillReport?:string
        }|undefined
      if(!job||!allowedExtensionAccount(job.accountId,auth)||job.leaseToken!==String(b.leaseToken||'')
        ||Number(job.executionTabId)!==Number(b.tabId)||String(job.executionDocument)!==String(b.document||'')||String(job.executionDocumentId)!==String(b.documentId||'')
        ||!job.leaseExpiresAt||Date.parse(job.leaseExpiresAt.replace(' ','T')+'Z')<=Date.now())return send(res,409,{error:'A execução perdeu o bloqueio exclusivo.'})
      let report:Record<string,unknown>={}
      try{report=job.fillReport?JSON.parse(job.fillReport):{}}catch{/* relatório legado inválido */}
      if(report.publishAttempted!==true)return send(res,409,{error:'Não há tentativa de publicação pendente para reconciliar.'})
      const nextReport={...report,publishAttempted:false,publishNotClicked:true,publishPhase:'not_clicked'}
      db.prepare('UPDATE publication_jobs SET fill_report=?,publish_attempt_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?')
        .run(JSON.stringify(nextReport),job.id,auth.organizationId)
      recordJobEvent(auth.organizationId,job.id,'publish_not_clicked',null,{confirmedNotClicked:true})
      return send(res,200,{ok:true})
    }
    const extensionFillResult = url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/fill-result$/)
    if (req.method === 'PATCH' && extensionFillResult) {
      const b=await jsonBody(req) as Record<string,unknown>
      const job = db.prepare(`SELECT j.id,j.status,j.vehicle_id vehicleId,j.social_account_id accountId,j.publish_attempt_at publishAttemptAt,j.lease_token leaseToken,j.last_lease_token lastLeaseToken,j.lease_expires_at leaseExpiresAt,j.execution_tab_id executionTabId,j.execution_document executionDocument,j.execution_document_id executionDocumentId,j.fill_report fillReport,
        j.attempt_count attemptCount,COALESCE(j.max_retries,3) maxRetries,j.retry_count retryCount,COALESCE(a.label,'Perfil não definido') accountLabel
        FROM publication_jobs j LEFT JOIN social_accounts a ON a.id=j.social_account_id
        WHERE j.id=? AND j.organization_id=?`).get(Number(extensionFillResult[1]),auth.organizationId) as {id:number;status:string;vehicleId:number;publishAttemptAt?:string;accountId:number;leaseToken?:string;lastLeaseToken?:string;leaseExpiresAt?:string;executionTabId?:number;executionDocument?:string;executionDocumentId?:string;fillReport?:string;attemptCount?:number;maxRetries?:number;retryCount?:number;accountLabel?:string}|undefined
      if (!job || !allowedExtensionAccount(job.accountId,auth)) return send(res,404,{error:'Trabalho não encontrado para este perfil.'})
      const previousReport=readPublicationReport(job.fillReport)
      const incomingLeaseToken=String(b.leaseToken||'')
      const identityMatches=Number(job.executionTabId)===Number(b.tabId)&&String(job.executionDocument)===String(b.document||'')
        &&String(job.executionDocumentId)===String(b.documentId||'')
      const latePublished=Boolean(b.published)&&job.status==='awaiting_confirmation'&&publicationMayExist(job)
        &&job.lastLeaseToken===incomingLeaseToken&&identityMatches
      if(job.lastLeaseToken===incomingLeaseToken&&identityMatches&&!latePublished){
        return send(res,200,{ok:true,status:job.status,idempotent:true})
      }
      // A venda interrompe a execução, mas conserva a identidade para reconciliar um resultado tardio.
      const soldInterrupted=job.status==='awaiting_confirmation'&&previousReport.saleInterrupted===true&&jobsIncludeSoldVehicle([job.id],auth.organizationId)
        &&job.leaseToken===incomingLeaseToken&&identityMatches
      const activeLease=job.status==='filling'&&job.leaseToken===incomingLeaseToken&&identityMatches&&Boolean(job.leaseExpiresAt)
        &&Date.parse(job.leaseExpiresAt!.replace(' ','T')+'Z')>Date.now()
      if(!activeLease&&!soldInterrupted&&!latePublished)return send(res,409,{error:'A execução perdeu o bloqueio exclusivo. Reabra o trabalho pela extensão.'})
      const error=String(b.error||'').slice(0,240)
      if (error&&soldInterrupted) {
        db.prepare('UPDATE publication_jobs SET error_code=?,last_lease_token=lease_token,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(error,job.id,auth.organizationId)
        recordJobEvent(auth.organizationId,job.id,'fill_error',null,{error,saleInterrupted:true})
        return send(res,200,{ok:true,status:'awaiting_confirmation'})
      }
      if (error) {
        const orgSettings = db.prepare('SELECT auto_retry autoRetry, max_retries maxRetries, alert_telegram_token alertTelegramToken, alert_telegram_chat_id alertTelegramChatId, alert_webhook_url alertWebhookUrl FROM organization_settings WHERE organization_id=?').get(auth.organizationId) as {autoRetry?:number;maxRetries?:number;alertTelegramToken?:string;alertTelegramChatId?:string;alertWebhookUrl?:string}|undefined
        if(publicationMayExist(job)){
          const report={...previousReport,error,publishAttempted:true,published:false,publishPhase:'result_unknown'}
          db.prepare(`UPDATE publication_jobs SET status='awaiting_confirmation',fill_report=?,error_code=?,last_lease_token=lease_token,
            lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
            .run(JSON.stringify(report),error,job.id,auth.organizationId)
          recordJobEvent(auth.organizationId,job.id,'publish_result_unknown',null,{error,publishAttempted:true})
          return send(res,200,{ok:true,status:'awaiting_confirmation',publishResultUnknown:true})
        }
        const autoRetryActive = Boolean(orgSettings?.autoRetry)
        const failureCode = isRetryableExtensionFailureCode(b.failureCode) ? String(b.failureCode) : ''
        const maxRetries = Math.max(1, Number(job.maxRetries || orgSettings?.maxRetries || 3))
        const retriesUsed = Number(job.retryCount || 0)

        if (autoRetryActive && failureCode && retriesUsed < maxRetries) {
          const delayMs = calculateBackoff(retriesUsed + 1, 60000, 600000, true)
          const nextScheduledAt = new Date(Date.now() + delayMs).toISOString()
          // A partir da 2ª falha consecutiva, considera mover para uma conta mais saudável em vez
          // de insistir sempre na mesma — findBestAccountForVehicle já exclui a conta atual, pois
          // este job ainda está ativo (status='error') para o mesmo veículo no momento da checagem.
          let targetAccountId = job.accountId
          let nextPriority: number | null = null
          if (retriesUsed >= 1) {
            const healthier = findBestAccountForVehicle(db, auth.organizationId, job.vehicleId)
            if (healthier && healthier.id !== job.accountId) {
              targetAccountId = healthier.id
              nextPriority = ((db.prepare(`SELECT COALESCE(MAX(queue_priority),0)+1 value FROM publication_jobs WHERE organization_id=? AND social_account_id=?
                AND status IN ('pending','filling','error','awaiting_confirmation')`).get(auth.organizationId, targetAccountId) as { value: number }).value) || 1
            }
          }
          if (nextPriority !== null) {
            db.prepare(`UPDATE publication_jobs SET status='pending',paused=0,extension_visible=1,scheduled_at=?,error_code=?,retry_count=retry_count+1,extension_version=?,last_lease_token=?,publish_attempt_at=NULL,social_account_id=?,queue_priority=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
              .run(nextScheduledAt,error,String(b.extensionVersion||'').slice(0,30),incomingLeaseToken,targetAccountId,nextPriority,job.id,auth.organizationId)
            recordJobEvent(auth.organizationId,job.id,'reassigned',null,{auto:true,reason:'repeated_failures',attempt:retriesUsed+1,queuePriority:nextPriority},job.accountId,targetAccountId)
          } else {
            db.prepare(`UPDATE publication_jobs SET status='pending',paused=0,extension_visible=1,scheduled_at=?,error_code=?,retry_count=retry_count+1,extension_version=?,last_lease_token=?,publish_attempt_at=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
              .run(nextScheduledAt,error,String(b.extensionVersion||'').slice(0,30),incomingLeaseToken,job.id,auth.organizationId)
          }
          recordJobEvent(auth.organizationId,job.id,'auto_retry_scheduled',null,{attempt:retriesUsed+1,maxRetries,delaySeconds:Math.round(delayMs/1000),scheduledAt:nextScheduledAt,error,failureCode,extensionVersion:String(b.extensionVersion||'').slice(0,30),rerouted:nextPriority!==null})
          return send(res,200,{ok:true,status:'pending',autoRetry:true,scheduledAt:nextScheduledAt,accountId:targetAccountId})
        }

        db.prepare(`UPDATE publication_jobs SET status='error',error_code=?,extension_version=?,last_lease_token=lease_token,publish_attempt_at=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
          .run(error,String(b.extensionVersion||'').slice(0,30),job.id,auth.organizationId)
        recordJobEvent(auth.organizationId,job.id,'fill_error',null,{error,failureCode:failureCode||null,retryable:Boolean(failureCode),extensionVersion:String(b.extensionVersion||'').slice(0,30),retriesExhausted:retriesUsed>=maxRetries})
        void sendCriticalAlert({
          jobId: job.id,
          accountLabel: job.accountLabel,
          type: 'fill_error',
          message: error,
          attemptCount: Number(job.attemptCount || 1),
        }, {
          telegramBotToken: orgSettings?.alertTelegramToken,
          telegramChatId: orgSettings?.alertTelegramChatId,
          webhookUrl: orgSettings?.alertWebhookUrl,
        })
        return send(res,200,{ok:true,status:'error',retriesExhausted:retriesUsed>=maxRetries})
      }
      const report={
        ...(soldInterrupted?{saleInterrupted:true}:{}),
        filledCount:Math.max(0,Number(b.filledCount)||0),totalCount:Math.max(0,Number(b.totalCount)||0),
        imageCount:Math.max(0,Number(b.imageCount)||0),missing:Array.isArray(b.missing)?b.missing.map(String).slice(0,30):[],
        fields:Array.isArray(b.fields)?b.fields.slice(0,30):[],advanced:Boolean(b.advanced),
        selectedGroups:Array.isArray(b.selectedGroups)?b.selectedGroups.map(String).slice(0,20):[],
        missingGroups:Array.isArray(b.missingGroups)?b.missingGroups.map(String).slice(0,20):[],
        flowIssues:Array.isArray(b.flowIssues)?b.flowIssues.map(value=>String(value).slice(0,240)).slice(0,10):[],published:Boolean(b.published),
        publishAttempted:Boolean(b.publishAttempted)||publicationMayExist(job),
        layoutDriftSuspected:Boolean(b.layoutDriftSuspected),notFoundFields:Array.isArray(b.notFoundFields)?b.notFoundFields.map(String).slice(0,20):[],
        ...(latePublished?{lateConfirmation:true}:{})
      }
      if(report.layoutDriftSuspected){
        const alertSettings=db.prepare('SELECT alert_telegram_token alertTelegramToken, alert_telegram_chat_id alertTelegramChatId, alert_webhook_url alertWebhookUrl FROM organization_settings WHERE organization_id=?').get(auth.organizationId) as {alertTelegramToken?:string;alertTelegramChatId?:string;alertWebhookUrl?:string}|undefined
        void sendCriticalAlert({
          jobId: job.id,
          accountLabel: job.accountLabel,
          type: 'layout_drift_suspected',
          message: `Possível mudança de layout do Facebook: campos não localizados (${report.notFoundFields.join(', ')||'diversos'}). Verifique se o formulário do Marketplace mudou antes de repetir automaticamente.`,
          details: { notFoundFields: report.notFoundFields },
        }, {
          telegramBotToken: alertSettings?.alertTelegramToken,
          telegramChatId: alertSettings?.alertTelegramChatId,
          webhookUrl: alertSettings?.alertWebhookUrl,
        })
      }
      const registeredGroups=marketplaceGroups(auth.organizationId)
      for(const target of latePublished?[]:report.selectedGroups){
        const parsed=parseGroupTarget(target),group=registeredGroups.find(item=>(parsed.groupKey&&item.groupKey===parsed.groupKey)||item.name.toLocaleLowerCase('pt-BR')===parsed.name.toLocaleLowerCase('pt-BR'))
        if(group)db.prepare('UPDATE marketplace_groups SET success_count=success_count+1,last_found_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(group.id,auth.organizationId)
      }
      for(const target of latePublished?[]:report.missingGroups){
        const parsed=parseGroupTarget(target),group=registeredGroups.find(item=>(parsed.groupKey&&item.groupKey===parsed.groupKey)||item.name.toLocaleLowerCase('pt-BR')===parsed.name.toLocaleLowerCase('pt-BR'))
        if(group)db.prepare('UPDATE marketplace_groups SET failure_count=failure_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(group.id,auth.organizationId)
      }
      if(report.published){
        const vehicleId=(db.prepare('SELECT vehicle_id vehicleId FROM publication_jobs WHERE id=? AND organization_id=?').get(job.id,auth.organizationId) as {vehicleId:number}).vehicleId
        db.exec('BEGIN')
        try{
          db.prepare(`UPDATE publication_jobs SET status='completed',publish_attempt_at=NULL,fill_report=?,extension_version=?,result_url=?,error_code=NULL,filled_at=CURRENT_TIMESTAMP,
            last_lease_token=COALESCE(lease_token,last_lease_token),lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
            .run(JSON.stringify(report),String(b.extensionVersion||'').slice(0,30),String(b.resultUrl||'').slice(0,500),job.id,auth.organizationId)
          refreshVehiclePublicationStatus(vehicleId,auth.organizationId)
          recordJobEvent(auth.organizationId,job.id,latePublished?'late_publish_confirmed':'auto_published',null,{resultUrl:String(b.resultUrl||'').slice(0,500),selectedGroups:report.selectedGroups.length,extensionVersion:String(b.extensionVersion||'').slice(0,30)})
          db.exec('COMMIT')
        }catch(error){db.exec('ROLLBACK');throw error}
        return send(res,200,{ok:true,status:'completed'})
      }
      db.prepare(`UPDATE publication_jobs SET status='awaiting_confirmation',fill_report=?,extension_version=?,error_code=NULL,filled_at=CURRENT_TIMESTAMP,
        last_lease_token=COALESCE(lease_token,last_lease_token),lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
        .run(JSON.stringify(report),String(b.extensionVersion||'').slice(0,30),job.id,auth.organizationId)
      if(soldInterrupted)db.prepare('UPDATE publication_jobs SET lease_token=? WHERE id=? AND organization_id=?').run(job.leaseToken!,job.id,auth.organizationId)
      recordJobEvent(auth.organizationId,job.id,'filled_waiting_confirmation',null,{filledCount:report.filledCount,totalCount:report.totalCount,imageCount:report.imageCount,advanced:report.advanced,publishAttempted:report.publishAttempted,missing:report.missing,missingGroups:report.missingGroups,flowIssues:report.flowIssues,extensionVersion:String(b.extensionVersion||'').slice(0,30)})
      return send(res,200,{ok:true,status:'awaiting_confirmation'})
    }
}
