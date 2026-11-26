import type { DatabaseSync } from 'node:sqlite'
import { getAlertCredentials } from './credential-vault.ts'
import { businessDate, localParts, localInstant } from '../lib/timezone.ts'
import { parseSqliteTimestamp, profileCapacity } from './profile-capacity.ts'
import { listingExpiryOverview } from './listing-expiry.ts'
import { canonicalMarketplaceListing } from './publication-ledger.ts'
import { logger } from '../lib/logger.ts'

export const telegramCategories = ['schedule','execution','published','review','recovery','profiles','limits','expiry','daily'] as const
type Category = typeof telegramCategories[number]
type Credentials = { telegramBotToken: string; telegramChatId: string }
type Delivery = { key: string; text: string }
const timezone = 'America/Sao_Paulo'
const clock = (date: number) => new Date(date).toLocaleString('pt-BR', {timeZone:timezone})
const clean = (value: unknown, max=120) => [...String(value ?? '')].map(char => {
  const code = char.charCodeAt(0)
  return code < 32 || code === 127 ? ' ' : char
}).join('').slice(0,max)
const eventMap: Record<string,{category:Category;title:string}> = {
  created:{category:'schedule',title:'📅 Trabalho criado'},
  scheduled:{category:'schedule',title:'📅 Publicação agendada'},
  smart_scheduled:{category:'schedule',title:'📅 Publicação agendada'},
  batch_scheduled:{category:'schedule',title:'📅 Publicação agendada'},
  autopilot_scheduled:{category:'schedule',title:'📅 Publicação agendada'},
  filling_started:{category:'execution',title:'🔄 Preenchimento iniciado'},
  auto_published:{category:'published',title:'✅ Publicação confirmada'},
  late_publish_confirmed:{category:'published',title:'✅ Publicação confirmada'},
  confirmed_published:{category:'published',title:'✅ Publicação confirmada'},
  filled_waiting_confirmation:{category:'review',title:'⚠️ Revisão necessária'},
  publish_result_unknown:{category:'review',title:'⚠️ Resultado de publicação incerto'},
  fill_result_conflict:{category:'review',title:'⚠️ Conflito de resultado'},
  auto_retry_scheduled:{category:'recovery',title:'🔄 Nova tentativa agendada'},
  stalled_recovered:{category:'recovery',title:'🔄 Execução recuperada'},
  reassigned:{category:'recovery',title:'🔄 Perfil alterado'},
}
const knownFields = ['Tipo de veículo','Localização','Ano','Fabricante','Modelo','Quilometragem','Preço','Câmbio','Combustível','Carroceria','Condição do veículo','Cor externa','Cor interna','Descrição','Fotos']
function readObject(value:string):Record<string,unknown>{
  try { const o=JSON.parse(value); return o && typeof o==='object' && !Array.isArray(o) ? o : {} } catch { return {} }
}
export function telegramMonitorSettings(db:DatabaseSync,org:number){
  const row=db.prepare('SELECT categories FROM telegram_monitor_settings WHERE organization_id=?').get(org) as {categories:string}|undefined
  let categories:Category[]=[]
  try { const raw=JSON.parse(row?.categories || '[]'); if(Array.isArray(raw)) categories=telegramCategories.filter(c=>raw.includes(c)) } catch { /* invalid legacy configuration remains disabled */ }
  return {categories, dailyTime:'21:30', timezone}
}
export function saveTelegramMonitorSettings(db:DatabaseSync,org:number,raw:unknown){
  if(!Array.isArray(raw)||raw.length>telegramCategories.length||raw.some(c=>!telegramCategories.includes(c))) throw new Error('Categorias inválidas.')
  const categories=telegramCategories.filter(c=>raw.includes(c))
  db.exec('BEGIN IMMEDIATE')
  try {
    const old=telegramMonitorSettings(db,org)
    if(JSON.stringify(old.categories)!==JSON.stringify(categories)){
      const cursor=(db.prepare('SELECT COALESCE(MAX(id),0) n FROM publication_job_events WHERE organization_id=?').get(org) as {n:number}).n
      db.prepare('INSERT INTO telegram_monitor_settings(organization_id,categories,event_cursor) VALUES(?,?,?) ON CONFLICT(organization_id) DO UPDATE SET categories=excluded.categories,event_cursor=excluded.event_cursor').run(org,JSON.stringify(categories),cursor)
      db.prepare('DELETE FROM telegram_monitor_profiles WHERE organization_id=?').run(org)
    }
    db.exec('COMMIT')
  }catch(error){db.exec('ROLLBACK');throw error}
  return telegramMonitorSettings(db,org)
}
export async function sendTelegramOperational(text:string,credentials:Credentials){
  try{
    const response=await fetch('https://api.telegram.org/bot'+credentials.telegramBotToken+'/sendMessage',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:credentials.telegramChatId,text:text.slice(0,3900),link_preview_options:{is_disabled:true}}),
    })
    const status=response.ok
    const body=await response.json() as {ok?:boolean}
    return status && body.ok===true
  }catch { return false } // Never log request URLs, external responses or credentials.
}
function isOnline(account:{status:string;lastSeen:string|null},now:number){
  const seen=parseSqliteTimestamp(account.lastSeen)
  return account.status==='connected' && seen!==null && seen<=now+60000 && now-seen<=300000
}
function claim(db:DatabaseSync,org:number,delivery:Delivery,now:number,items:Delivery[]){
  if(items.length>=20)return false
  const result=db.prepare('INSERT OR IGNORE INTO telegram_monitor_delivery(organization_id,delivery_key,claimed_at) VALUES(?,?,?)').run(org,delivery.key,now)
  if(result.changes)items.push(delivery)
  return true
}
function collect(db:DatabaseSync,org:number,now:number){
  const settings=telegramMonitorSettings(db,org)
  const enabled=new Set(settings.categories)
  const items:Delivery[]=[]
  if(!enabled.size)return items
  const day=businessDate(now,timezone)!
  db.exec('BEGIN IMMEDIATE')
  try{
    const row=db.prepare('SELECT event_cursor cursor FROM telegram_monitor_settings WHERE organization_id=?').get(org) as {cursor:number}|undefined
    if(!row){db.exec('COMMIT');return items}
    const accounts=db.prepare('SELECT id,label,status,last_seen_at lastSeen FROM social_accounts WHERE organization_id=? ORDER BY id').all(org) as Array<{id:number;label:string;status:string;lastSeen:string|null}>
    const online=accounts.filter(a=>isOnline(a,now)).length
    const parts=localParts(new Date(now),timezone)
    const carrier=new Date(Date.UTC(parts.year,parts.month-1,parts.day))
    const dayStart=localInstant(carrier,0,timezone).toISOString()
    const dayEnd=localInstant(carrier,1440,timezone).toISOString()
    if(enabled.has('daily') && parts.hour*60+parts.minute>=21*60+30){
      const totals=db.prepare("SELECT status,COUNT(*) n FROM publication_jobs WHERE organization_id=? GROUP BY status").all(org) as Array<{status:string;n:number}>
      const count=(status:string)=>totals.find(t=>t.status===status)?.n||0
      const confirmed=db.prepare("SELECT COUNT(*) n FROM publication_listing_ledger WHERE organization_id=? AND unixepoch(first_confirmed_at)>=unixepoch(?) AND unixepoch(first_confirmed_at)<unixepoch(?)").get(org,dayStart,dayEnd) as {n:number}
      const errors=db.prepare("SELECT COUNT(DISTINCT publication_job_id) n FROM publication_job_events WHERE organization_id=? AND event_type='fill_error' AND unixepoch(created_at)>=unixepoch(?) AND unixepoch(created_at)<unixepoch(?)").get(org,dayStart,dayEnd) as {n:number}
      const lines=accounts.slice(0,20).map(a=>{
        const n=(db.prepare("SELECT COUNT(*) n FROM publication_listing_ledger WHERE organization_id=? AND social_account_id=? AND unixepoch(first_confirmed_at)>=unixepoch(?) AND unixepoch(first_confirmed_at)<unixepoch(?)").get(org,a.id,dayStart,dayEnd) as {n:number}).n
        const cap=profileCapacity(db,org,a.id,now)
        return clean(a.label,60)+': '+n+' confirmações; '+cap.used+'/'+cap.dailyLimit+' execuções'
      })
      claim(db,org,{key:'daily:'+day,text:['📊 AutoFlow — resumo até '+clock(now),'Confirmações registradas hoje: '+confirmed.n,'Trabalhos com erro hoje: '+errors.n,'Aguardando revisão (atual): '+count('awaiting_confirmation'),'Pendentes (atual): '+count('pending'),'Perfis online: '+online+'/'+accounts.length,...lines].join('\n')},now,items)
    }
    const events=db.prepare('SELECT e.id,e.event_type type,e.created_at createdAt,e.details,j.id jobId,j.scheduled_at scheduledAt,a.label accountLabel,v.year,v.make,v.model,l.canonical_url url FROM publication_job_events e JOIN publication_jobs j ON j.id=e.publication_job_id AND j.organization_id=e.organization_id JOIN vehicles v ON v.id=j.vehicle_id AND v.organization_id=j.organization_id LEFT JOIN social_accounts a ON a.id=j.social_account_id AND a.organization_id=j.organization_id LEFT JOIN publication_listing_ledger l ON l.publication_job_id=j.id AND l.organization_id=j.organization_id WHERE e.organization_id=? AND e.id>? ORDER BY e.id LIMIT 100').all(org,row.cursor) as Array<{id:number;type:string;createdAt:string;details:string;jobId:number;scheduledAt:string|null;accountLabel:string|null;year:number;make:string;model:string;url:string|null}>
    let cursor=row.cursor
    for(const e of events){
      const info=Object.hasOwn(eventMap,e.type)?eventMap[e.type]:undefined
      const stamp=parseSqliteTimestamp(e.createdAt)
      if(info && enabled.has(info.category) && stamp!==null && stamp>=now-86400000){
        if(items.length>=12)break
        const details=readObject(e.details)
        const schedule=parseSqliteTimestamp(typeof details.scheduledAt==='string'?details.scheduledAt:e.scheduledAt)
        const missing=Array.isArray(details.missing)?knownFields.filter(field=>(details.missing as unknown[]).includes(field)):[]
        const url=canonicalMarketplaceListing(e.url).canonicalUrl
        const text=[info.title,clean([e.year,e.make,e.model].join(' ')),'Trabalho #'+e.jobId,'Perfil atual: '+clean(e.accountLabel||'Não definido'), 'Evento: '+clock(stamp)]
        if(info.category==='schedule' && schedule!==null)text.push('Agendado: '+clock(schedule))
        if(info.category==='review')text.push(missing.length?'Campos a revisar: '+missing.join(', '):'Confira o resultado no painel antes de qualquer nova tentativa.')
        if(info.category==='published' && url)text.push(url)
        claim(db,org,{key:'event:'+e.id,text:text.join('\n')},now,items)
      }
      cursor=e.id
    }
    db.prepare('UPDATE telegram_monitor_settings SET event_cursor=? WHERE organization_id=?').run(cursor,org)
    for(const a of accounts){
      if(items.length>=18)break
      const current=Number(isOnline(a,now))
      const previous=db.prepare('SELECT online FROM telegram_monitor_profiles WHERE organization_id=? AND account_id=?').get(org,a.id) as {online:number}|undefined
      if(enabled.has('profiles') && previous && previous.online!==current){
        claim(db,org,{key:'profile:'+a.id+':'+now+':'+current,text:(current?'🟢 Perfil reconectado: ':'🔴 Perfil sem presença recente: ')+clean(a.label)+'\n'+clock(now)},now,items)
      }
      db.prepare('INSERT INTO telegram_monitor_profiles(organization_id,account_id,online,changed_at) VALUES(?,?,?,?) ON CONFLICT(organization_id,account_id) DO UPDATE SET online=excluded.online,changed_at=excluded.changed_at WHERE online!=excluded.online').run(org,a.id,current,now)
      if(enabled.has('limits')){
        const cap=profileCapacity(db,org,a.id,now)
        if(cap.blockedByDailyLimit)claim(db,org,{key:'limit:'+a.id+':'+day,text:'🛑 Limite diário atingido: '+clean(a.label)+'\n'+cap.used+'/'+cap.dailyLimit+' execuções (inclui tentativas).'},now,items)
      }
    }
    if(enabled.has('expiry')){
      for(const item of listingExpiryOverview(db,org,null,now).items){
        if(items.length>=20)break
        if(item.state==='warning' && item.expiresAt)claim(db,org,{key:'expiry:'+item.jobId+':'+item.expiresAt,text:'⏳ Anúncio próximo do vencimento\n'+clean(item.vehicle)+' · '+clean(item.accountLabel)+'\nPrazo: '+clock(Date.parse(item.expiresAt))+'\nRevise no painel.'},now,items)
      }
    }
    db.exec('COMMIT')
  }catch(error){db.exec('ROLLBACK');throw error}
  return items
}
export async function runTelegramMonitor(db:DatabaseSync,now=Date.now(),send=sendTelegramOperational,credentials=getAlertCredentials){
  // Claims are committed before network I/O: at most one send attempt, even
  // across processes. A crash or ambiguous response may lose an alert; no replay.
  const orgs=db.prepare("SELECT organization_id org FROM telegram_monitor_settings WHERE categories!='[]' ORDER BY organization_id").all() as Array<{org:number}>
  for(const {org} of orgs){
    try{
      const config=credentials(db,org)
      if(!config.telegramBotToken || !config.telegramChatId)continue
      for(const item of collect(db,org,now)){
        let ok=false
        try{ok=await send(item.text,config)}catch{/* bounded failure */}
        db.prepare('UPDATE telegram_monitor_delivery SET outcome=? WHERE organization_id=? AND delivery_key=?').run(ok?'sent':'failed',org,item.key)
      }
    }catch{logger.warn('TelegramMonitor','Falha no monitor de notificações',{organizationId:org})}
  }
  db.prepare('DELETE FROM telegram_monitor_delivery WHERE claimed_at<?').run(now-30*86400000)
}
