import type { DatabaseSync } from 'node:sqlite'
import { profileCapacity, parseSqliteTimestamp } from './profile-capacity.ts'
import { consumerState, latestConsumerDecision, sanitizeExecutionDiagnostics, sanitizeConsumerDiagnostic } from './execution-diagnostics.ts'
import { readPublicationReport, publicationReviewKind, publicationMayExist } from './publication-evidence.ts'
import { classifyExtensionFailure, publicationReadinessIssues } from './publication-policy.ts'
import { openResultConflict } from './result-conflicts.ts'
import { listingExpiryPolicy } from './listing-expiry.ts'
import { canonicalMarketplaceListing } from './publication-ledger.ts'
import { autopilotDiagnostics, summarizeAutopilotDiagnostics } from './autopilot-diagnostics.ts'
import { operationalBottlenecks } from './operational-bottlenecks.ts'

type Property = {type:'integer'|'string'; minimum?:number; maximum?:number; enum?:readonly string[]; description:string}
type Definition = {description:string; properties:Record<string,Property>; required?:string[]; sources:string[]}
const id = (description:string):Property=>({type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER,description})
const limit:Property={type:'integer',minimum:1,maximum:30,description:'Quantidade máxima (padrão 10)'}
const beforeId=id('Cursor exclusivo da página anterior')
const hours:Property={type:'integer',minimum:1,maximum:720,description:'Janela em horas (padrão 24; máximo 30 dias)'}
const statuses=['pending','filling','awaiting_confirmation','error','completed','removed','canceled'] as const
const stockStatuses=['Rascunho','Pronto','Publicado','Vendido'] as const
const definitions = {
  resumo_operacional:{description:'Totais atuais de estoque, trabalhos e presença de perfis; confirmações registradas hoje.',properties:{},sources:['vehicles','publication_jobs','social_accounts','publication_listing_ledger']},
  diagnosticar_operacao:{description:'Diagnóstico atual de por que o piloto automático recorrente pode ou não agendar veículos: motivos, perfis elegíveis, exemplos e estado da rodada. Somente leitura.',properties:{limit},sources:['vehicles','vehicle_images','publication_jobs','social_accounts','organization_settings','autopilot_state','published_ads','publication_listing_ledger']},
  identificar_gargalos:{description:'Classifica gargalos atuais por revisão obrigatória, atenção e espera normal; contagens por entidade e exemplos, sem executar ações.',properties:{limit},sources:['vehicles','vehicle_images','publication_jobs','publication_job_events','social_accounts','organization_settings','autopilot_state','published_ads','publication_listing_ledger']},
  listar_veiculos:{description:'Lista paginada de veículos, dados cadastrais essenciais e quantidade de fotos.',properties:{limit,beforeId,status:{type:'string',enum:stockStatuses,description:'Status cadastral'}},sources:['vehicles','vehicle_images']},
  consultar_veiculo:{description:'Detalhes essenciais e campos faltantes de um veículo, sem descrição livre nem arquivos.',properties:{vehicleId:id('ID do veículo')},required:['vehicleId'],sources:['vehicles','vehicle_images']},
  listar_publicacoes:{description:'Trabalhos, agendamento, perfil, tentativas e status atual; não confirma estado externo.',properties:{limit,beforeId,vehicleId:id('Filtrar veículo'),accountId:id('Filtrar perfil'),status:{type:'string',enum:statuses,description:'Status do trabalho'}},sources:['publication_jobs','vehicles','social_accounts']},
  diagnosticar_trabalho:{description:'Evidências estruturadas do preenchimento, campos faltantes e diagnóstico da última execução de um trabalho.',properties:{jobId:id('ID do trabalho')},required:['jobId'],sources:['publication_jobs','publication_job_events']},
  listar_perfis:{description:'Presença recente, estado do consumidor, capacidade e limites internos de cada perfil.',properties:{limit,beforeId},sources:['social_accounts','publication_job_events','organization_settings']},
  historico_operacional:{description:'Eventos operacionais conhecidos e datas; sem detalhes brutos ou credenciais.',properties:{limit,beforeId,hours,jobId:id('Filtrar trabalho')},sources:['publication_job_events']},
  historico_consumidor:{description:'Diagnósticos estruturados do consumidor da extensão; retenção máxima de 30 dias.',properties:{limit,beforeId,hours,accountId:id('Filtrar perfil')},sources:['consumer_history']},
  consultar_configuracoes:{description:'Regras operacionais não secretas e último estado do piloto automático.',properties:{},sources:['organization_settings','autopilot_state']},
  listar_grupos:{description:'Grupos cadastrados, ativação, prioridade e contadores; sem links de convite.',properties:{limit,beforeId},sources:['marketplace_groups']},
  listar_anuncios:{description:'Anúncios registrados no ledger local e política de vencimento; não consulta o Facebook ao vivo.',properties:{limit,beforeId,vehicleId:id('Filtrar veículo')},sources:['publication_listing_ledger','publication_jobs','organization_settings']},
  historico_diagnosticos:{description:'Hipóteses registradas pelo monitor de IA, frequência por causa, estado atual dos trabalhos e entrega; não comprova solução aplicada.',properties:{limit,beforeId,hours,jobId:id('Filtrar trabalho')},sources:['commander_diagnostic_history','publication_jobs']},
  historico_ia:{description:'Histórico de operações da IA, sem prompts, respostas ou chaves.',properties:{limit,beforeId},sources:['ai_operation_history']},
} satisfies Record<string,Definition>
type ToolName = keyof typeof definitions
export class QueryToolError extends Error {}
const safeText=(v:unknown,max=120)=>typeof v==='string'?v.slice(0,max).replace(/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}|\d{6,}:[A-Za-z0-9_-]{20,}|enc:v1:[A-Za-z0-9_:-]+)/gi,'[oculto]'):null
const bounded=(v:unknown,max=100000)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max?v:null
const allowed=(v:unknown,values:readonly string[])=>typeof v==='string'&&values.includes(v)?v:null
const fields=['Tipo de veículo','Localização','Ano','Fabricante','Modelo','Quilometragem','Preço','Câmbio','Combustível','Carroceria','Condição','Condição do veículo','Cor externa','Cor interna','Descrição','Fotos','Tipo','Marca','Cor exterior','Cor interior']
const eventTypes=['created','scheduled','smart_scheduled','batch_scheduled','schedule_removed','autopilot_scheduled','filling_started','filled_waiting_confirmation','auto_published','late_publish_confirmed','confirmed_published','fill_error','publish_result_unknown','duplicate_blocked','selector_circuit_breaker_opened','execution_diagnostics','stalled_recovered','stalled_exhausted','stalled_publish_ambiguous','auto_retry_scheduled','retry_requested','reassigned','paused','resumed','canceled','marked_removed','fill_result_conflict','fill_result_conflict_resolved','hidden_from_extension','shown_in_extension','job_nearly_stuck','failed_interval_released']
const consumerExtras=['presence_first_observed','presence_restored','consumer_state_enabled','consumer_state_paused','consumer_state_unknown']
const auditActions=['description_generated','description_preview','description_approved','listing_text_preview','listing_text_approved','manual_pilot_preview','manual_pilot_executed','assistant_command','api_key_test','ai_configuration_saved']
const list=(rows:Array<Record<string,unknown>>,n:number)=>({items:rows.slice(0,n),nextBeforeId:rows.length>n?rows[n-1].id:null})
export function commanderQueryCatalog(){
  return Object.entries(definitions).map(([name,d])=>{
    const def:Definition=d
    return {name,description:def.description,readOnly:true,sources:[...def.sources],
      parameters:{type:'object',properties:def.properties,required:def.required||[],additionalProperties:false}}
  })
}
function parseArgs(name:unknown,raw:unknown){
  if(typeof name!=='string'||!Object.hasOwn(definitions,name))throw new QueryToolError('Ferramenta de consulta desconhecida.')
  const def:Definition=definitions[name as ToolName]
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new QueryToolError('Parâmetros devem ser um objeto.')
  const input=raw as Record<string,unknown>
  for(const [key,value] of Object.entries(input)){
    if(!Object.hasOwn(def.properties,key))throw new QueryToolError('Parâmetro não permitido.')
    const p=def.properties[key]
    if(p.type==='integer'?(typeof value!=='number'||!Number.isSafeInteger(value)||value<(p.minimum||1)||value>(p.maximum||Number.MAX_SAFE_INTEGER)):
      (typeof value!=='string'||!p.enum?.includes(value)))throw new QueryToolError('Valor de parâmetro inválido.')
  }
  if(def.required?.some(key=>!Object.hasOwn(input,key)))throw new QueryToolError('Parâmetro obrigatório ausente.')
  return {name:name as ToolName,args:input as Record<string,number|string>,def}
}
// Reuse the same closed argument validation for persistent conversation context.
export function validatedQueryReference(name:unknown,args:unknown){
  const parsed=parseArgs(name,args)
  return {tool:parsed.name,arguments:Object.fromEntries(Object.entries(parsed.args))}
}
const vehicleColumns="v.id,v.year,substr(v.make,1,120) make,substr(v.model,1,120) model,substr(v.trim,1,120) trim,v.price,v.km,v.status,v.sold_at soldAt,substr(v.stock_code,1,120) stockCode,(SELECT COUNT(*) FROM vehicle_images i WHERE i.organization_id=v.organization_id AND i.vehicle_id=v.id) photoCount"
const cleanVehicle=(v:Record<string,unknown>)=>({id:v.id,year:v.year,make:safeText(v.make),model:safeText(v.model),trim:safeText(v.trim),price:v.price,km:v.km,status:allowed(v.status,stockStatuses),sold:Boolean(v.soldAt||v.status==='Vendido'),stockCode:safeText(v.stockCode),photoCount:v.photoCount})
const jobColumns="j.id,j.vehicle_id vehicleId,j.social_account_id accountId,substr(a.label,1,120) accountLabel,j.status,j.scheduled_at scheduledAt,j.attempt_count attempts,j.retry_count retries,j.paused,j.extension_visible visible,j.updated_at updatedAt,j.publish_attempt_at publishAttemptAt,j.fill_report fillReport,j.error_code errorCode"
const jobJoin="FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id AND v.organization_id=j.organization_id LEFT JOIN social_accounts a ON a.id=j.social_account_id AND a.organization_id=j.organization_id"
function cleanJob(db:DatabaseSync,org:number,j:Record<string,unknown>){
  return {id:j.id,vehicleId:j.vehicleId,accountId:j.accountId,accountLabel:safeText(j.accountLabel),status:allowed(j.status,statuses),scheduledAt:j.scheduledAt,attempts:j.attempts,retries:j.retries,paused:Boolean(j.paused),visible:Boolean(j.visible),updatedAt:j.updatedAt,
    reviewKind:publicationReviewKind({status:String(j.status),publishAttemptAt:j.publishAttemptAt,fillReport:j.fillReport}),publicationMayExist:publicationMayExist(j),openConflict:openResultConflict(db,org,Number(j.id))}
}
function online(status:unknown,seen:unknown,now:number){
  const stamp=parseSqliteTimestamp(typeof seen==='string'?seen:null)
  return status==='connected'&&stamp!==null&&stamp<=now+60000&&now-stamp<=300000
}
/** Organization identity must come from an authenticated server context, never model arguments. */
export function runCommanderQuery(db:DatabaseSync,org:number,tool:unknown,input:unknown={}){
  if(!Number.isSafeInteger(org)||org<1||!db.prepare('SELECT 1 FROM organizations WHERE id=?').get(org))
    throw new QueryToolError('Contexto de empresa inválido.')
  const {name,args,def}=parseArgs(tool,input)
  const n=Number(args.limit||10),cursor=Number(args.beforeId||0),now=Date.now()
  const vehicleId=Number(args.vehicleId||0),accountId=Number(args.accountId||0),jobId=Number(args.jobId||0)
  const status=String(args.status||''),since=new Date(now-Number(args.hours||24)*3600000).toISOString()
  let data:unknown
  switch(name){
    case 'resumo_operacional': {
      const stock=db.prepare("SELECT COUNT(*) total,COALESCE(SUM(sold_at IS NULL AND status!='Vendido'),0) notSold,COALESCE(SUM(sold_at IS NULL AND status='Pronto'),0) ready,COALESCE(SUM(CASE WHEN sold_at IS NULL AND status!='Vendido' THEN price ELSE 0 END),0) stockValue FROM vehicles WHERE organization_id=?").get(org)
      const jobs=db.prepare("SELECT status,COUNT(*) count FROM publication_jobs WHERE organization_id=? GROUP BY status").all(org).filter(j=>allowed(j.status,statuses))
      const profiles=db.prepare('SELECT COUNT(*) total,COALESCE(SUM(status=\'connected\' AND datetime(last_seen_at)>=datetime(\'now\',\'-5 minutes\') AND datetime(last_seen_at)<=datetime(\'now\',\'+1 minute\')),0) online FROM social_accounts WHERE organization_id=?').get(org)
      const confirmed=db.prepare("SELECT COUNT(*) count FROM publication_listing_ledger WHERE organization_id=? AND autoflow_day(first_confirmed_at)=autoflow_day(CURRENT_TIMESTAMP)").get(org)
      data={stock,jobs,profiles,confirmedToday:confirmed?.count||0,note:'Contagens locais; pronto não garante elegibilidade, presença não garante login no Facebook.'};break
    }
    case 'diagnosticar_operacao': {
      const diagnostic=autopilotDiagnostics(db,org,true)
      const summary=summarizeAutopilotDiagnostics(diagnostic)
      const examples=diagnostic.vehicles.filter(v=>v.previewReasons.length||v.executionReasons.length).slice(0,n)
      const profileExamples=summary.profiles.slice(0,n)
      data={
        recurringEnabled:diagnostic.recurringEnabled,
        nextRunAt:diagnostic.nextRunAt,
        lastStatus:allowed(diagnostic.lastStatus,['idle','running','completed','error','failed']),
        lastJobsCreated:diagnostic.lastJobsCreated,
        totalVehicles:summary.totalVehicles,
        previewCandidateCount:summary.previewCandidateCount,
        passingInitialChecks:summary.passingInitialChecks,
        reasonCounts:summary.reasonCounts,
        profiles:{total:summary.profiles.length,eligible:summary.profiles.filter(p=>p.canSchedule).length,items:profileExamples,omitted:Math.max(0,summary.profiles.length-n)},
        blockedVehicles:{total:diagnostic.vehicles.length-diagnostic.passingInitialChecks,items:examples.map(v=>({
          id:v.id,reasons:[...v.previewReasons,...v.executionReasons].map(reason=>reason.code),
          blockingJobCount:v.blockingJobs.length,
          blockingJobs:v.blockingJobs.slice(0,5).map(job=>({id:job.id,status:allowed(job.status,statuses),reviewKind:job.reviewKind,paused:Boolean(job.paused),visible:Boolean(job.visible)})),
        }))},
        note:'Diagnóstico local de elegibilidade inicial do piloto recorrente; não garante agendamento, execução ou estado externo. Motivos podem coexistir no mesmo veículo. Nenhuma ação foi executada.',
      };break
    }
    case 'identificar_gargalos': {
      data=operationalBottlenecks(db,org,n);break
    }
    case 'listar_veiculos': {
      const rows=db.prepare('SELECT '+vehicleColumns+' FROM vehicles v WHERE v.organization_id=? AND (?=0 OR v.id<?) AND (?=\'\' OR v.status=?) ORDER BY v.id DESC LIMIT ?').all(org,cursor,cursor,status,status,n+1)
      data=list(rows.map(cleanVehicle),n);break
    }
    case 'consultar_veiculo': {
      const v=db.prepare('SELECT '+vehicleColumns+',v.location,v.description,v.vehicle_type vehicleType,v.transmission,v.fuel_type fuelType,v.body_type bodyType,v.exterior_color exteriorColor,v.interior_color interiorColor,v.vehicle_condition condition FROM vehicles v WHERE v.organization_id=? AND v.id=?').get(org,vehicleId)
      if(!v)throw new QueryToolError('Veículo não encontrado nesta empresa.')
      const readiness=publicationReadinessIssues(v as Parameters<typeof publicationReadinessIssues>[0],Number(v.photoCount))
      data={...cleanVehicle(v),location:safeText(v.location),vehicleType:safeText(v.vehicleType),transmission:safeText(v.transmission),fuelType:safeText(v.fuelType),bodyType:safeText(v.bodyType),exteriorColor:safeText(v.exteriorColor),interiorColor:safeText(v.interiorColor),condition:safeText(v.condition),missingFields:readiness,descriptionPresent:Boolean(String(v.description||'').trim())};break
    }
    case 'listar_publicacoes': {
      const rows=db.prepare('SELECT '+jobColumns+' '+jobJoin+' WHERE j.organization_id=? AND (?=0 OR j.id<?) AND (?=0 OR j.vehicle_id=?) AND (?=0 OR j.social_account_id=?) AND (?=\'\' OR j.status=?) ORDER BY j.id DESC LIMIT ?').all(org,cursor,cursor,vehicleId,vehicleId,accountId,accountId,status,status,n+1)
      data=list(rows.map(j=>cleanJob(db,org,j)),n);break
    }
    case 'diagnosticar_trabalho': {
      const job=db.prepare('SELECT '+jobColumns+' '+jobJoin+' WHERE j.organization_id=? AND j.id=?').get(org,jobId)
      if(!job)throw new QueryToolError('Trabalho não encontrado nesta empresa.')
      const report=readPublicationReport(job.fillReport)
      const event=db.prepare("SELECT id,created_at createdAt,details FROM publication_job_events WHERE organization_id=? AND publication_job_id=? AND event_type='execution_diagnostics' ORDER BY id DESC LIMIT 1").get(org,jobId)
      const details=readPublicationReport(event?.details)
      data={job:cleanJob(db,org,job),failure:classifyExtensionFailure(job.errorCode),
        report:{filledCount:bounded(report.filledCount,100),totalCount:bounded(report.totalCount,100),imageCount:bounded(report.imageCount,100),missing:Array.isArray(report.missing)?fields.filter(f=>(report.missing as unknown[]).includes(f)):[],published:typeof report.published==='boolean'?report.published:null,publishAttempted:typeof report.publishAttempted==='boolean'?report.publishAttempted:null},
        diagnostics:event?{eventId:event.id,createdAt:event.createdAt,attemptCount:bounded(details.attemptCount),entries:sanitizeExecutionDiagnostics(details.diagnostics).slice(0,30)}:null,
        note:'Evidências históricas da extensão; não constituem confirmação externa de publicação.'};break
    }
    case 'listar_perfis': {
      const rows=db.prepare('SELECT id,substr(label,1,120) label,status,last_seen_at lastSeenAt,automation_paused paused FROM social_accounts WHERE organization_id=? AND (?=0 OR id<?) ORDER BY id DESC LIMIT ?').all(org,cursor,cursor,n+1)
      data=list(rows.map(a=>{
        const cap=profileCapacity(db,org,Number(a.id),now)
        const decision=latestConsumerDecision(db,org,Number(a.id),now)
        return {id:a.id,label:safeText(a.label),online:online(a.status,a.lastSeenAt,now),lastSeenAt:a.lastSeenAt,paused:Boolean(a.paused),consumer:consumerState(db,org,Number(a.id),now),decision:sanitizeConsumerDiagnostic(decision),capacity:{used:cap.used,remaining:cap.remaining,queuedToday:cap.queuedToday,dailyLimit:cap.dailyLimit,intervalMinutes:cap.intervalMinutes,nextAllowedAt:cap.nextAllowedAt}}
      }),n);break
    }
    case 'historico_operacional': {
      const rows=db.prepare('SELECT e.id,e.publication_job_id jobId,e.event_type code,e.created_at createdAt FROM publication_job_events e JOIN publication_jobs j ON j.id=e.publication_job_id AND j.organization_id=e.organization_id WHERE e.organization_id=? AND datetime(e.created_at)>=datetime(?) AND (?=0 OR e.id<?) AND (?=0 OR e.publication_job_id=?) AND e.event_type IN ('+eventTypes.map(()=>'?').join(',')+') ORDER BY e.id DESC LIMIT ?').all(org,since,cursor,cursor,jobId,jobId,...eventTypes,n+1)
      data=list(rows,n);break
    }
    case 'historico_consumidor': {
      const rows=db.prepare('SELECT h.id,h.account_id accountId,h.code,h.observed_at observedAt,h.received_at receivedAt,j.id jobId,h.queue_size queueSize,h.http_status httpStatus,h.retry_after_seconds retryAfterSeconds FROM consumer_history h JOIN social_accounts a ON a.id=h.account_id AND a.organization_id=h.organization_id LEFT JOIN publication_jobs j ON j.id=h.job_id AND j.organization_id=h.organization_id WHERE h.organization_id=? AND h.observed_at>=? AND (?=0 OR h.id<?) AND (?=0 OR h.account_id=?) ORDER BY h.id DESC LIMIT ?').all(org,Date.parse(since),cursor,cursor,accountId,accountId,n+1)
      data={...list(rows.map(h=>({id:h.id,accountId:h.accountId,observedAt:h.observedAt,receivedAt:h.receivedAt,diagnostic:sanitizeConsumerDiagnostic(h)||{code:allowed(h.code,consumerExtras)||'unknown'}})),n),retentionDays:30};break
    }
    case 'consultar_configuracoes': {
      const settings=db.prepare('SELECT daily_limit dailyLimit,execution_interval_minutes intervalMinutes,auto_advance autoAdvance,fill_groups fillGroups,auto_publish autoPublish,auto_retry autoRetry,max_retries maxRetries,stuck_timeout_minutes stuckTimeoutMinutes,autopilot_enabled autopilotEnabled,autopilot_interval_minutes autopilotIntervalMinutes,ai_provider aiProvider FROM organization_settings WHERE organization_id=?').get(org)
      const pilot=db.prepare('SELECT next_run_at nextRunAt,last_status lastStatus,last_jobs_created lastJobsCreated FROM autopilot_state WHERE organization_id=?').get(org)
      data={settings:settings?{...settings,aiProvider:allowed(settings.aiProvider,['auto','gemini','openai','deepseek','procedural'])}:null,pilot:pilot?{nextRunAt:pilot.nextRunAt,lastStatus:allowed(pilot.lastStatus,['idle','running','completed','error','failed']),lastJobsCreated:pilot.lastJobsCreated}:null,expiry:listingExpiryPolicy(db,org)};break
    }
    case 'listar_grupos': {
      const rows=db.prepare('SELECT id,substr(name,1,120) name,active,priority,success_count successCount,failure_count failureCount,last_found_at lastFoundAt FROM marketplace_groups WHERE organization_id=? AND (?=0 OR id<?) ORDER BY id DESC LIMIT ?').all(org,cursor,cursor,n+1)
      data=list(rows.map(g=>({...g,name:safeText(g.name)})),n);break
    }
    case 'listar_anuncios': {
      const rows=db.prepare('SELECT l.id,l.vehicle_id vehicleId,l.publication_job_id jobId,l.social_account_id accountId,l.status,l.first_confirmed_at confirmedAt,l.removed_at removedAt,l.external_listing_id externalId,l.canonical_url url,l.expiry_review_until reviewUntil FROM publication_listing_ledger l JOIN publication_jobs j ON j.id=l.publication_job_id AND j.organization_id=l.organization_id JOIN vehicles v ON v.id=l.vehicle_id AND v.organization_id=l.organization_id WHERE l.organization_id=? AND (?=0 OR l.id<?) AND (?=0 OR l.vehicle_id=?) ORDER BY l.id DESC LIMIT ?').all(org,cursor,cursor,vehicleId,vehicleId,n+1)
      const policy=listingExpiryPolicy(db,org)
      data={...list(rows.map(l=>{
        const canonical=canonicalMarketplaceListing(l.url)
        const stamp=parseSqliteTimestamp(typeof l.confirmedAt==='string'?l.confirmedAt:null)
        const trusted=Boolean(l.externalId&&canonical.externalListingId===l.externalId&&stamp!==null&&stamp<=now)
        const review=parseSqliteTimestamp(typeof l.reviewUntil==='string'?l.reviewUntil:null)
        return {id:l.id,vehicleId:l.vehicleId,jobId:l.jobId,accountId:l.accountId,status:allowed(l.status,['active','removed']),confirmedAt:trusted?l.confirmedAt:null,removedAt:l.removedAt,url:trusted?canonical.canonicalUrl:null,expiresAt:trusted&&policy.enabled&&l.status==='active'?new Date(Math.max(stamp!+policy.days*86400000,review||0)).toISOString():null}
      }),n),policy,note:'Ledger local; não verifica presença ou retirada no Facebook.'};break
    }
    case 'historico_diagnosticos': {
      const min=Math.max(Date.parse(since),now-30*86400000)
      const scope='h.organization_id=? AND h.claimed_at>=? AND (?=0 OR h.job_id=?)'
      const rows=db.prepare('SELECT h.event_id id,h.job_id jobId,h.family,h.cause,h.claimed_at claimedAt,h.analysis_status analysisStatus,h.delivery_status deliveryStatus,j.status jobStatus FROM commander_diagnostic_history h LEFT JOIN publication_jobs j ON j.id=h.job_id AND j.organization_id=h.organization_id WHERE '+scope+' AND (?=0 OR h.event_id<?) ORDER BY h.event_id DESC LIMIT ?').all(org,min,jobId,jobId,cursor,cursor,n+1)
      const causes=['insufficient','location','transmission','photos','authentication','timeout','layout','uncertain','duplicate','validation','manual_review']
      const frequencies=db.prepare('SELECT h.cause,COUNT(*) count,COUNT(DISTINCT h.job_id) jobs FROM commander_diagnostic_history h WHERE '+scope+' GROUP BY h.cause ORDER BY count DESC LIMIT 20').all(org,min,jobId,jobId)
      data={...list(rows.map(h=>({...h,family:allowed(h.family,['fill','review','uncertain','timeout','layout','duplicate']),cause:allowed(h.cause,causes),analysisStatus:allowed(h.analysisStatus,['claimed','analyzed','fallback']),deliveryStatus:allowed(h.deliveryStatus,['pending','sent','failed','skipped']),jobStatus:allowed(h.jobStatus,statuses)})),n),
        frequencies:frequencies.map(h=>({...h,cause:allowed(h.cause,causes)})),retentionDays:30,note:'Somente diagnósticos reservados pelo monitor (com limites e deduplicação), não todas as falhas. Estado atual não comprova que a orientação resolveu o erro.'};break
    }
    case 'historico_ia': {
      const rows=db.prepare('SELECT id,action,outcome,provider,items,created_at createdAt FROM ai_operation_history WHERE organization_id=? AND (?=0 OR id<?) ORDER BY id DESC LIMIT ?').all(org,cursor,cursor,n+1)
      data=list(rows.map(a=>({...a,action:allowed(a.action,auditActions),outcome:allowed(a.outcome,['preview','applied','rejected','tested','configured']),provider:allowed(a.provider,['auto','deepseek','gemini','openai','procedural'])})),n);break
    }
  }
  const result={tool:name,asOf:new Date(now).toISOString(),sources:def.sources,readOnly:true,data}
  if(JSON.stringify(result).length>36000)throw new QueryToolError('Resultado muito grande. Reduza o limite.')
  return result
}
