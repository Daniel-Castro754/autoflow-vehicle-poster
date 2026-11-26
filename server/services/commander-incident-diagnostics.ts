import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { businessDate } from '../lib/timezone.ts'
import { logger } from '../lib/logger.ts'
import { getAiCredentials, getAlertCredentials } from './credential-vault.ts'
import { deepseekText } from './deepseek.ts'
import { sendTelegramOperational } from './telegram-monitor.ts'
import { sanitizeExecutionDiagnostics } from './execution-diagnostics.ts'
import { classifyExtensionFailure } from './publication-policy.ts'
import { readPublicationReport } from './publication-evidence.ts'
import { parseSqliteTimestamp } from './profile-capacity.ts'

const dailyLimit=10
const cooldown=30*60000
const retention=30*86400000
const events={
  fill_error:'fill',filled_waiting_confirmation:'review',publish_result_unknown:'uncertain',
  stalled_publish_ambiguous:'uncertain',fill_result_conflict:'uncertain',stalled_exhausted:'timeout',
  stalled_recovered:'timeout',job_nearly_stuck:'timeout',selector_circuit_breaker_opened:'layout',
  duplicate_blocked:'duplicate',
} as const
const causes={
  insufficient:['Evidências insuficientes','Confira os detalhes do trabalho e o estado real do anúncio no painel.'],
  location:['Localização não confirmada','Revise manualmente a cidade e o estado no formulário.'],
  transmission:['Câmbio não confirmado','Revise o campo de câmbio e o cadastro.'],
  photos:['Falha na conferência ou no carregamento das fotos','Confira os arquivos originais e as fotos efetivamente carregadas.'],
  authentication:['Autenticação ou verificação do Facebook necessária','Verifique a sessão manualmente e respeite as verificações da plataforma.'],
  timeout:['Tempo limite ou execução interrompida','Verifique a presença da extensão, a conexão e o estado real do anúncio.'],
  layout:['Possível alteração ou incompatibilidade do formulário','Mantenha a pausa existente e revise os seletores antes de nova execução.'],
  uncertain:['Resultado de publicação não confirmado','Confira Seus classificados antes de liberar qualquer nova tentativa.'],
  duplicate:['Possível duplicidade detectada','Confira o anúncio existente e os dados do veículo. Não republique para contornar a rejeição.'],
  validation:['Cadastro ou preenchimento incompleto','Confira os campos faltantes e corrija somente dados reais.'],
  manual_review:['Trabalho encaminhado para revisão','Confira o formulário e o estado do anúncio manualmente.'],
} as const
type Cause=keyof typeof causes
type Credentials={telegramBotToken:string;telegramChatId:string}
type Settings={organization_id:number;enabled:number;destination_hash:string;revision:number;event_cursor:number}
type Event={id:number;jobId:number;code:keyof typeof events;createdAt:string;details:string}
type Dependencies={credentials?:(db:DatabaseSync,org:number)=>Credentials;key?:(db:DatabaseSync,org:number)=>string;analyze?:typeof deepseekText;send?:typeof sendTelegramOperational;now?:()=>number}
const configRow=(db:DatabaseSync,org:number)=>db.prepare('SELECT * FROM commander_diagnostic_settings WHERE organization_id=?').get(org) as Settings|undefined
const configured=(c:Credentials)=>/^\d+:[A-Za-z0-9_-]+$/.test(c.telegramBotToken)&&/^-\d+$/.test(c.telegramChatId)
const fingerprint=(c:Credentials)=>createHash('sha256').update(JSON.stringify([c.telegramBotToken,c.telegramChatId])).digest('hex')
const getKey=(db:DatabaseSync,org:number)=>getAiCredentials(db,org).deepseekApiKey||process.env.DEEPSEEK_API_KEY||''
const count=(db:DatabaseSync,org:number,day:string)=>Number(db.prepare('SELECT COUNT(*) n FROM commander_diagnostic_history WHERE organization_id=? AND business_day=?').get(org,day)?.n||0)
export function commanderDiagnosticSettings(db:DatabaseSync,org:number,credentials:(db:DatabaseSync,org:number)=>Credentials=getAlertCredentials,now=Date.now()){
  const row=configRow(db,org),c=credentials(db,org)
  const bound=configured(c)&&row?.destination_hash===fingerprint(c)
  const day=businessDate(now,'America/Sao_Paulo')!
  const history=db.prepare('SELECT event_id eventId,job_id jobId,family,cause,analysis_status analysisStatus,delivery_status deliveryStatus,claimed_at claimedAt FROM commander_diagnostic_history WHERE organization_id=? ORDER BY claimed_at DESC,event_id DESC LIMIT 10').all(org)
  return {enabled:Boolean(row?.enabled&&bound),configured:configured(c),requiresRebind:Boolean(row?.enabled&&!bound),usage:{day,used:count(db,org,day),limit:dailyLimit},history}
}
export function saveCommanderDiagnosticSettings(db:DatabaseSync,org:number,input:unknown,credentials:(db:DatabaseSync,org:number)=>Credentials=getAlertCredentials,now=Date.now()){
  const value=input as {enabled?:unknown;acknowledge?:unknown}|null
  if(!value||typeof value.enabled!=='boolean')throw new Error('Configuração inválida.')
  const c=credentials(db,org)
  if(value.enabled&&(!configured(c)||value.acknowledge!==true))throw new Error('Confirme o envio de evidências ao DeepSeek e ao grupo.')
  db.exec('BEGIN IMMEDIATE')
  try{
    const old=configRow(db,org),hash=configured(c)?fingerprint(c):''
    if(!old||old.enabled!==Number(value.enabled)||old.destination_hash!==hash){
      const cursor=Number(db.prepare('SELECT COALESCE(MAX(id),0) n FROM publication_job_events WHERE organization_id=?').get(org)?.n||0)
      db.prepare('INSERT INTO commander_diagnostic_settings(organization_id,enabled,destination_hash,revision,event_cursor) VALUES(?,?,?,1,?) ON CONFLICT(organization_id) DO UPDATE SET enabled=excluded.enabled,destination_hash=excluded.destination_hash,revision=commander_diagnostic_settings.revision+1,event_cursor=excluded.event_cursor').run(org,Number(value.enabled),hash,cursor)
    }
    db.exec('COMMIT')
  }catch(error){db.exec('ROLLBACK');throw error}
  return commanderDiagnosticSettings(db,org,credentials,now)
}
const number=(v:unknown,max=100000)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max?v:null
const fieldNames=['Tipo de veículo','Localização','Ano','Fabricante','Modelo','Quilometragem','Preço','Câmbio','Combustível','Carroceria','Condição','Condição do veículo','Cor externa','Cor interna','Descrição','Fotos']
function evidenceFor(db:DatabaseSync,org:number,e:Event){
  const d=readPublicationReport(e.details)
  const prior=db.prepare("SELECT id,details,created_at createdAt FROM publication_job_events WHERE organization_id=? AND publication_job_id=? AND event_type='execution_diagnostics' AND id<? AND id>COALESCE((SELECT MAX(id) FROM publication_job_events WHERE organization_id=? AND publication_job_id=? AND event_type='filling_started' AND id<?),0) ORDER BY id DESC LIMIT 1").get(org,e.jobId,e.id,org,e.jobId,e.id)
  const priorAt=parseSqliteTimestamp(typeof prior?.createdAt==='string'?prior.createdAt:null),eventAt=parseSqliteTimestamp(e.createdAt)
  const related=Boolean(prior&&priorAt!==null&&eventAt!==null&&eventAt>=priorAt&&eventAt-priorAt<=cooldown&&['fill_error','filled_waiting_confirmation','publish_result_unknown','selector_circuit_breaker_opened'].includes(e.code))
  const entries=related?sanitizeExecutionDiagnostics(readPublicationReport(prior?.details).diagnostics).slice(0,30):[]
  const missing=Array.isArray(d.missing)?fieldNames.filter(v=>(d.missing as unknown[]).includes(v)):Array.isArray(d.missingFields)?fieldNames.filter(v=>(d.missingFields as unknown[]).includes(v)):[]
  return {eventId:e.id,jobId:e.jobId,event:e.code,createdAt:e.createdAt,diagnosticEventId:related?prior?.id:null,entries,missing,
    failure:classifyExtensionFailure(d.failureCode),filledCount:number(d.filledCount,100),totalCount:number(d.totalCount,100),imageCount:number(d.imageCount,100),
    elapsedMinutes:number(d.elapsedMinutes),retryCount:number(d.retryCount),maxRetries:number(d.maxRetries),
    publishAttempted:typeof d.publishAttempted==='boolean'?d.publishAttempted:null,
    reviewKind:typeof d.reviewKind==='string'&&['publication_uncertain','fill_incomplete','manual_review','review_unknown'].includes(d.reviewKind)?d.reviewKind:null}
}
function candidates(e:ReturnType<typeof evidenceFor>):Cause[]{
  const family=events[e.event]
  if(family==='duplicate')return ['duplicate']
  if(family==='uncertain'||e.publishAttempted===true||e.reviewKind==='publication_uncertain')return ['uncertain']
  if(family==='layout')return ['layout']
  if(family==='timeout')return ['timeout']
  if(e.failure.category==='authentication')return ['authentication']
  if(e.failure.code==='selector_layout_drift')return ['layout']
  if(e.failure.code==='publish_outcome_unknown')return ['uncertain']
  const result:Cause[]=[]
  if(e.missing.includes('Localização')||e.entries.some(x=>x.code==='location_checked'&&x.matched===0))result.push('location')
  if(e.missing.includes('Câmbio')||e.entries.some(x=>x.code==='transmission_checked'&&x.matched===0))result.push('transmission')
  if(e.failure.code==='photo_identity_unverified'||e.missing.includes('Fotos')||e.entries.some(x=>['photo_identity_unverified','photo_download_failed','photo_accept_timeout','photo_count_unverified','photo_input_missing','photos_empty'].includes(String(x.code))))result.push('photos')
  if(e.missing.length||e.failure.category==='validation'||(e.filledCount!==null&&e.totalCount!==null&&e.filledCount<e.totalCount))result.push('validation')
  if(e.failure.category==='transient')result.push('timeout')
  if(!result.length&&family==='review'&&e.reviewKind==='manual_review')result.push('manual_review')
  return [...result,'insufficient']
}
function claim(db:DatabaseSync,settings:Settings,e:Event,now:number){
  const day=businessDate(now,'America/Sao_Paulo')!,family=events[e.code]
  db.exec('BEGIN IMMEDIATE')
  try{
    const advanced=db.prepare('UPDATE commander_diagnostic_settings SET event_cursor=? WHERE organization_id=? AND enabled=1 AND revision=? AND event_cursor<?').run(e.id,settings.organization_id,settings.revision,e.id)
    let claimed=false
    const stamp=parseSqliteTimestamp(e.createdAt)
    if(advanced.changes&&stamp!==null&&stamp<=now+30000&&stamp>=now-86400000&&count(db,settings.organization_id,day)<dailyLimit&&
      !db.prepare('SELECT 1 FROM commander_diagnostic_history WHERE organization_id=? AND job_id=? AND family=? AND claimed_at>? LIMIT 1').get(settings.organization_id,e.jobId,family,now-cooldown)){
      claimed=Boolean(db.prepare('INSERT OR IGNORE INTO commander_diagnostic_history(organization_id,event_id,job_id,family,business_day,claimed_at) VALUES(?,?,?,?,?,?)').run(settings.organization_id,e.id,e.jobId,family,day,now).changes)
    }
    db.exec('COMMIT');return claimed
  }catch(error){db.exec('ROLLBACK');throw error}
}
export async function runCommanderIncidentDiagnostics(db:DatabaseSync,deps:Dependencies={}){
  const credentials=deps.credentials||getAlertCredentials,key=deps.key||getKey,analyze=deps.analyze||deepseekText,send=deps.send||sendTelegramOperational,now=deps.now||Date.now
  const settings=db.prepare('SELECT * FROM commander_diagnostic_settings WHERE enabled=1 ORDER BY organization_id').all() as Settings[]
  for(const s of settings){
    const org=s.organization_id
    try{
      const c=credentials(db,org)
      const current=()=>{const row=configRow(db,org),latest=credentials(db,org);return Boolean(row?.enabled&&row.revision===s.revision&&configured(latest)&&fingerprint(latest)===s.destination_hash)}
      if(!configured(c)||fingerprint(c)!==s.destination_hash||!current())continue
      const rows=db.prepare('SELECT e.id,e.publication_job_id jobId,e.event_type code,e.created_at createdAt,e.details FROM publication_job_events e JOIN publication_jobs j ON j.id=e.publication_job_id AND j.organization_id=e.organization_id WHERE e.organization_id=? AND e.id>? AND e.event_type IN ('+Object.keys(events).map(()=>'?').join(',')+') ORDER BY e.id LIMIT 30').all(org,s.event_cursor,...Object.keys(events)) as Event[]
      let processed=0
      for(const e of rows){
        if(!current()||processed>=2)break
        if(!claim(db,s,e,now()))continue
        processed++
        const evidence=evidenceFor(db,org,e),choices=candidates(evidence)
        let cause:Cause=choices[0],analysisStatus='fallback',deliveryStatus='skipped'
        const apiKey=key(db,org)
        if(apiKey&&current()){
          const prompt='Classifique a hipótese mais sustentada por estas evidências operacionais históricas. Não invente fatos. Responda SOMENTE com um dos códigos permitidos, sem explicação, comando ou recomendação. Se houver incerteza use insufficient quando permitido. Códigos: '+choices.join(', ')+'. Evidências: '+JSON.stringify(evidence)
          try{
            const result=await analyze(apiKey,prompt,{maxTokens:32})
            if(result.ok&&choices.includes(result.text.trim() as Cause)){cause=result.text.trim() as Cause;analysisStatus='analyzed'}
          }catch{/* fallback sem conteúdo externo */}
        }
        if(current()){
          const text=['🔍 AutoFlow — diagnóstico '+(analysisStatus==='analyzed'?'assistido por DeepSeek':'local (IA indisponível ou resposta inválida)'),
            'Trabalho #'+e.jobId+' · evento #'+e.id,'Ocorrência: '+e.code,'Horário: '+new Date(parseSqliteTimestamp(e.createdAt)!).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}),
            'Hipótese: '+causes[cause][0],...(evidence.missing.length?['Campos: '+evidence.missing.join(', ')]:[]),
            ...(evidence.diagnosticEventId?['Diagnóstico relacionado: #'+evidence.diagnosticEventId]:[]),
            'Orientação: '+causes[cause][1],'Evidência histórica, não confirmação do Facebook. Nenhuma ação foi executada.'].join('\n')
          try{deliveryStatus=await send(text,c)?'sent':'failed'}catch{deliveryStatus='failed'}
        }
        db.prepare('UPDATE commander_diagnostic_history SET cause=?,analysis_status=?,delivery_status=? WHERE organization_id=? AND event_id=?').run(cause,analysisStatus,deliveryStatus,org,e.id)
      }
    }catch{logger.warn('CommanderDiagnostics','Falha na análise de ocorrências',{organizationId:org})}
  }
  db.prepare('DELETE FROM commander_diagnostic_history WHERE claimed_at<?').run(now()-retention)
}
