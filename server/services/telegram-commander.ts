import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { getAlertCredentials } from './credential-vault.ts'
import { sendCommanderReply } from './commander-telegram-reply.ts'
import { parseSqliteTimestamp } from './profile-capacity.ts'
import { logger } from '../lib/logger.ts'
import { answerCommanderQuestion, commanderUsage } from './commander-conversation.ts'
import { proposeCommanderPause, proposeCommanderAction, parseCommanderSchedule, decideCommanderAction } from './commander-permissions.ts'
import { clearCommanderMemory, commanderMemoryCount, rememberCommanderQueries, type MemoryScope } from './commander-memory.ts'

type Credentials = { telegramBotToken: string; telegramChatId: string }
type Row = {
  organization_id: number; enabled: number; user_ids: string; bot_hash: string; destination_hash: string
  ai_enabled: number; memory_enabled: number; revision: number; activated_at: number; next_offset: number; last_update_at: number
  lease_owner: string; lease_until: number; last_poll_at: number; last_status: string
}
type Result = { ok: true; result: unknown } | { ok: false; status: string }
type Request = (token: string, method: 'getMe'|'getUpdates', payload: Record<string,unknown>) => Promise<Result>
type Dependencies = {
  credentials?: (db: DatabaseSync, org:number)=>Credentials
  request?: Request
  send?: typeof sendCommanderReply
  now?: ()=>number
  answer?: typeof answerCommanderQuestion
}
const digest = (value:string)=>createHash('sha256').update(value).digest('hex')
const botHash = (c:Credentials)=>digest(c.telegramBotToken)
const destinationHash = (c:Credentials)=>digest(JSON.stringify([c.telegramBotToken,c.telegramChatId]))
const configured = (c:Credentials)=>/^\d+:[A-Za-z0-9_-]+$/.test(c.telegramBotToken) && /^-\d+$/.test(c.telegramChatId)
const rowFor = (db:DatabaseSync,org:number)=>db.prepare('SELECT * FROM telegram_commander WHERE organization_id=?').get(org) as Row|undefined
const ids = (row:Row|undefined):string[]=>{
  try{
    const value:unknown=JSON.parse(row?.user_ids||'[]')
    return Array.isArray(value)?value.filter((id):id is string=>typeof id==='string'&&/^[1-9]\d{0,15}$/.test(id)):[]
  }catch{return []}
}
export function telegramCommanderSettings(db:DatabaseSync,org:number,credentials=getAlertCredentials){
  const row=rowFor(db,org)
  const c=credentials(db,org)
  const bound=configured(c)&&row?.destination_hash===destinationHash(c)
  return {enabled:Boolean(row?.enabled&&bound),userIds:bound?ids(row):[],
    aiEnabled:Boolean(row?.enabled&&bound&&row.ai_enabled),usage:commanderUsage(db,org),
    memoryEnabled:Boolean(row?.enabled&&bound&&row.ai_enabled&&row.memory_enabled),memoryCount:bound?commanderMemoryCount(db,org):0,
    configured:configured(c),requiresRebind:Boolean(row?.enabled&&!bound),
    lastPollAt:row?.last_poll_at?new Date(row.last_poll_at).toISOString():null,
    lastStatus:row?.enabled&&!bound?'destination_changed':row?.last_status||'idle'}
}
export function saveTelegramCommanderSettings(db:DatabaseSync,org:number,input:unknown,credentials:(db:DatabaseSync,org:number)=>Credentials=getAlertCredentials,now=Date.now()){
  const value=input as {enabled?:unknown;userIds?:unknown;acknowledgeGroup?:unknown;aiEnabled?:unknown;acknowledgeDeepseek?:unknown;memoryEnabled?:unknown;acknowledgeMemory?:unknown}|null
  if(!value||typeof value.enabled!=='boolean'||!Array.isArray(value.userIds)||value.userIds.length>10||
    value.userIds.some(id=>typeof id!=='string'||!/^[1-9]\d{0,15}$/.test(id)||!Number.isSafeInteger(Number(id))))
    throw new Error('Informe IDs numéricos válidos (até 10).')
  const userIds=[...new Set(value.userIds as string[])].sort()
  if(value.aiEnabled!==undefined&&typeof value.aiEnabled!=='boolean')throw new Error('Configuração de IA inválida.')
  const aiEnabled=value.enabled&&value.aiEnabled===true
  if(aiEnabled&&(!userIds.length||value.acknowledgeDeepseek!==true))throw new Error('Autorize usuários e confirme o envio de dados ao DeepSeek.')
  if(value.memoryEnabled!==undefined&&typeof value.memoryEnabled!=='boolean')throw new Error('Configuração de memória inválida.')
  const memoryEnabled=aiEnabled&&value.memoryEnabled===true
  if(memoryEnabled&&value.acknowledgeMemory!==true)throw new Error('Confirme a retenção e reutilização das referências de consultas.')
  const c=credentials(db,org)
  if(value.enabled&&(!configured(c)||value.acknowledgeGroup!==true))
    throw new Error('Configure o bot/grupo e confirme que as respostas serão visíveis aos membros.')
  db.exec('BEGIN IMMEDIATE')
  try{
    const old=rowFor(db,org)
    const fingerprint=configured(c)?destinationHash(c):''
    const hash=configured(c)?botHash(c):''
    if(value.enabled&&db.prepare('SELECT 1 FROM telegram_commander WHERE bot_hash=? AND enabled=1 AND organization_id!=?').get(hash,org))
      throw new Error('Este bot já possui um receptor ativo. Use um bot exclusivo.')
    if(!old||old.enabled!==Number(value.enabled)||old.ai_enabled!==Number(aiEnabled)||old.memory_enabled!==Number(memoryEnabled)||old.destination_hash!==fingerprint||JSON.stringify(ids(old))!==JSON.stringify(userIds)){
      // Keep the cursor for the same bot, even when enabling/disabling or changing the allowlist.
      // The activation timestamp rejects queued commands from prior authorizations.
      const sameBot=old?.bot_hash===hash
      db.prepare('INSERT INTO telegram_commander(organization_id,enabled,user_ids,bot_hash,destination_hash,ai_enabled,memory_enabled,revision,activated_at,next_offset,last_update_at,last_status) VALUES(?,?,?,?,?,?,?,1,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET enabled=excluded.enabled,ai_enabled=excluded.ai_enabled,memory_enabled=excluded.memory_enabled,user_ids=excluded.user_ids,bot_hash=excluded.bot_hash,destination_hash=excluded.destination_hash,revision=telegram_commander.revision+1,activated_at=excluded.activated_at,next_offset=excluded.next_offset,last_update_at=excluded.last_update_at,last_status=excluded.last_status')
        .run(org,Number(value.enabled),JSON.stringify(userIds),hash,fingerprint,Number(aiEnabled),Number(memoryEnabled),now,sameBot?old.next_offset:0,sameBot?old.last_update_at:0,value.enabled?'idle':'disabled')
      clearCommanderMemory(db,org)
    }
    db.exec('COMMIT')
  }catch(error){db.exec('ROLLBACK');throw error}
  // The public read path uses the same injected destination for tests.
  return telegramCommanderSettings(db,org,()=>({...c,webhookUrl:''}))
}
export async function telegramRequest(token:string,method:'getMe'|'getUpdates',payload:Record<string,unknown>):Promise<Result>{
  try{
    const res=await fetch('https://api.telegram.org/bot'+token+'/'+method,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
    })
    if(!res.ok){void res.body?.cancel().catch(()=>{});return {ok:false,status:'http_'+res.status}}
    const body=await res.json() as {ok?:boolean;result?:unknown}
    return body.ok===true?{ok:true,result:body.result}:{ok:false,status:'telegram_error'}
  }catch{return {ok:false,status:'network_error'}}
}
type Message = {date?:number;text?:string;forward_origin?:unknown;from?:{id?:number;is_bot?:boolean};chat?:{id?:number;type?:string};sender_chat?:unknown}
type Update = {update_id?:number;message?:Message}
const clean = (value:unknown)=>String(value??'').replace(/\s+/g,' ').slice(0,70)
function statusText(db:DatabaseSync,org:number,now:number){
  const profiles=db.prepare('SELECT label,status,last_seen_at seen FROM social_accounts WHERE organization_id=? ORDER BY id LIMIT 20').all(org) as Array<{label:string;status:string;seen:string|null}>
  const all=(db.prepare('SELECT COUNT(*) n FROM social_accounts WHERE organization_id=?').get(org) as {n:number}).n
  const stock=(db.prepare("SELECT COUNT(*) n FROM vehicles WHERE organization_id=? AND sold_at IS NULL AND status!='Vendido'").get(org) as {n:number}).n
  const jobs=db.prepare('SELECT status,COUNT(*) n FROM publication_jobs WHERE organization_id=? GROUP BY status').all(org) as Array<{status:string;n:number}>
  const count=(status:string)=>jobs.find(j=>j.status===status)?.n||0
  return ['📊 AutoFlow — status atual','Veículos não marcados como vendidos: '+stock,'Pendentes: '+count('pending'),'Em execução: '+count('filling'),'Aguardando revisão: '+count('awaiting_confirmation'),'Com erro: '+count('error'),'Perfis cadastrados: '+all,
    ...profiles.map(p=>{const seen=parseSqliteTimestamp(p.seen);return clean(p.label)+': '+(p.status==='connected'&&seen!==null&&seen<=now+60000&&now-seen<=300000?'online':'offline')}),
    'Presença recente não garante que o Facebook esteja autenticado.'].join('\n')
}
function replyFor(db:DatabaseSync,row:Row,c:Credentials,username:string,update:Update,now:number):string|{question:string;userId:string}|null{
  const m=update.message
  if(!m||m.sender_chat||m.from?.is_bot!==false||!Number.isSafeInteger(m.from.id)||
    !Number.isSafeInteger(m.chat?.id)||String(m.chat?.id)!==c.telegramChatId||
    !['group','supergroup'].includes(m.chat?.type||'')||
    !Number.isSafeInteger(m.date)||Number(m.date)*1000<Math.floor(row.activated_at/1000)*1000||
    now-Number(m.date)*1000>120000||Number(m.date)*1000>now+30000||
    typeof m.text!=='string'||m.text.length>1100||m.forward_origin)return null
  const live=m.text.trim().match(/^\/(pausar|adiar|cancelar_trabalho)(?:@([A-Za-z0-9_]+))?\s+([1-9]\d{0,15})(?:\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}-03:00))?$/i)
  if(live){
    if((live[2]&&live[2].toLowerCase()!==username.toLowerCase())||!ids(row).includes(String(m.from.id)))return null
    const actor={userId:String(m.from.id),destinationHash:row.destination_hash,receiverRevision:row.revision}
    const verb=live[1].toLowerCase()
    const scheduledAt=live[4]?parseCommanderSchedule(live[4]):null
    if((verb==='adiar'&&!scheduledAt)||(verb!=='adiar'&&live[4]))return 'Use /adiar ID AAAA-MM-DDTHH:MM-03:00 ou /pausar ID ou /cancelar_trabalho ID.'
    return proposeCommanderAction(db,row.organization_id,actor,verb==='pausar'?'pausar_trabalho_real':verb==='adiar'?'adiar_trabalho':'cancelar_trabalho_pendente',Number(live[3]),scheduledAt,c,now)
  }
  const action=m.text.trim().match(/^\/(solicitar_pausa|autorizar|recusar)(?:@([A-Za-z0-9_]+))?\s+([a-zA-Z0-9]+)$/i)
  if(action){
    if((action[2]&&action[2].toLowerCase()!==username.toLowerCase())||!ids(row).includes(String(m.from.id)))return null
    const actor={userId:String(m.from.id),destinationHash:row.destination_hash,receiverRevision:row.revision}
    if(action[1].toLowerCase()==='solicitar_pausa'){
      if(!/^[1-9]\d{0,15}$/.test(action[3]))return 'Informe o ID numérico do trabalho.'
      return proposeCommanderPause(db,row.organization_id,actor,Number(action[3]),c,now)
    }
    return decideCommanderAction(db,row.organization_id,actor,action[3],action[1].toLowerCase()==='autorizar',c,now)
  }
  const ai=m.text.trim().match(/^\/ia(?:@([A-Za-z0-9_]+))?\s+([\s\S]+)$/i)
  if(ai){
    if((ai[1]&&ai[1].toLowerCase()!==username.toLowerCase())||!ids(row).includes(String(m.from.id)))return null
    if(!row.ai_enabled)return 'Perguntas com DeepSeek desativadas. Ative no painel.'
    return {question:ai[2].trim(),userId:String(m.from.id)}
  }
  const match=m.text.trim().match(/^\/(meu_id|ajuda|status|limpar_memoria)(?:@([A-Za-z0-9_]+))?$/i)
  if(!match||(match[2]&&match[2].toLowerCase()!==username.toLowerCase()))return null
  const command=match[1].toLowerCase()
  const user=String(m.from.id)
  // Setup mode can identify the caller, but never disclose operational data.
  if(command==='meu_id')return 'Seu ID numérico: '+user+'. Cadastre-o no painel do AutoFlow.'
  if(!ids(row).includes(user))return null
  if(command==='limpar_memoria'){
    clearCommanderMemory(db,row.organization_id,user)
    return 'Suas referências de consultas foram limpas no AutoFlow. O histórico do Telegram, backups e diagnósticos operacionais não foram alterados.'
  }
  if(command==='ajuda')return 'AutoFlow AI Commander — consulta somente leitura\n/status — situação do sistema\n/meu_id — seu identificador\n/ajuda — comandos\n/ia pergunta — consulta DeepSeek, se ativada no painel.\n/limpar_memoria — limpa suas referências locais. /solicitar_pausa ID — demonstração de autorização, se permitida.\n/autorizar CÓDIGO ou /recusar CÓDIGO — decidir proposta. /pausar ID, /adiar ID AAAA-MM-DDTHH:MM-03:00, /cancelar_trabalho ID — propostas reais se autorizadas. Não publica nem retira anúncios.'
  return statusText(db,row.organization_id,now)
}

export async function sweepTelegramCommander(db:DatabaseSync,deps:Dependencies={}){
  const credentials=deps.credentials||getAlertCredentials
  const request=deps.request||telegramRequest
  const send=deps.send||sendCommanderReply
  const now=deps.now||Date.now
  const rows=db.prepare('SELECT * FROM telegram_commander WHERE enabled=1 ORDER BY organization_id').all() as Row[]
  // A token can have exactly one active receiver in this database. A lease
  // prevents overlapping polls by different server processes.
  await Promise.all(rows.map(async row=>{
    const org=row.organization_id, owner=randomUUID(), started=now()
    const lease=db.prepare('UPDATE telegram_commander SET lease_owner=?,lease_until=? WHERE organization_id=? AND enabled=1 AND revision=? AND lease_until<=?').run(owner,started+120000,org,row.revision,started)
    if(!lease.changes)return
    const current=()=>{const r=rowFor(db,org);return r?.enabled===1&&r.revision===row.revision&&r.lease_owner===owner&&r.lease_until>now()?r:undefined}
    let status='idle'
    try{
      const c=credentials(db,org)
      if(!configured(c)||destinationHash(c)!==row.destination_hash){status='destination_changed';return}
      const sameDestination=()=>{const latest=credentials(db,org);return configured(latest)&&destinationHash(latest)===row.destination_hash}
      const identity=await request(c.telegramBotToken,'getMe',{})
      if(!identity.ok){status=identity.status;return}
      const bot=identity.result as {is_bot?:boolean;username?:string}|null
      if(bot?.is_bot!==true||typeof bot.username!=='string'||!/^[A-Za-z0-9_]+$/.test(bot.username)){status='invalid_bot';return}
      if(!current()||!sameDestination())return
      // Telegram may choose a new random update ID after a week without updates.
      const reset=row.last_update_at>0&&started-row.last_update_at>6*86400000
      const updates=await request(c.telegramBotToken,'getUpdates',{timeout:10,limit:10,allowed_updates:['message'],offset:reset?0:row.next_offset})
      if(!updates.ok){status=updates.status;return}
      if(!Array.isArray(updates.result)){status='invalid_response';return}
      status='online'
      const batch=(updates.result as Update[]).filter(u=>u&&Number.isSafeInteger(u.update_id)&&Number(u.update_id)>=0).sort((a,b)=>Number(a.update_id)-Number(b.update_id)).slice(0,10)
      let offset=reset?0:row.next_offset
      let replies=0
      for(const update of batch){
        const r=current()
        if(!r||!sameDestination()||replies>=5)break
        const id=Number(update.update_id)
        if(id<offset)continue
        // Commit consumption before reply: a crash may lose a response, but
        // does not replay commands. No raw message bodies are stored.
        const claimed=db.prepare('UPDATE telegram_commander SET next_offset=?,last_update_at=? WHERE organization_id=? AND revision=? AND enabled=1 AND lease_owner=? AND lease_until>?').run(id+1,now(),org,row.revision,owner,now())
        if(!claimed.changes)break
        offset=id+1
        const reply=replyFor(db,r,c,bot.username,update,now())
        if(reply&&replies<5&&current()&&sameDestination()){
          replies++
          if(typeof reply==='string'){
            if(!await send(reply,c))status='reply_failed'
          }else{
            const authorized=()=>Boolean(current()?.ai_enabled&&sameDestination())
            const memory:MemoryScope|undefined=r.memory_enabled?{userId:reply.userId,destinationHash:r.destination_hash,revision:r.revision}:undefined
            const result=await (deps.answer||answerCommanderQuestion)(db,org,reply.question,authorized,{memory})
            if(authorized()){
              if(!await send(result.text,c,{format:true}))status='reply_failed'
              else if(memory&&result.status==='answered'&&authorized()){
                try{rememberCommanderQueries(db,org,memory,result.references,now())}
                catch{logger.warn('TelegramCommander','Falha ao registrar referências de consulta',{organizationId:org})}
              }
            }
            // One AI question per lease. Later messages remain for the next poll.
            break
          }
        }
      }
    }catch{status='internal_error';logger.warn('TelegramCommander','Falha no receptor',{organizationId:org})}
    finally{
      db.prepare('UPDATE telegram_commander SET lease_owner=?,lease_until=0,last_poll_at=?,last_status=? WHERE organization_id=? AND lease_owner=? AND revision=?').run('',now(),status,org,owner,row.revision)
      // A setting revision may change during a poll. Release only our lease.
      db.prepare("UPDATE telegram_commander SET lease_owner='',lease_until=0 WHERE organization_id=? AND lease_owner=?").run(org,owner)
    }
  }))
}
export function createTelegramCommanderWorker(db:DatabaseSync){
  let timer:NodeJS.Timeout|null=null
  let running=false
  const tick=async()=>{
    if(running)return
    running=true
    try{await sweepTelegramCommander(db)}catch{logger.warn('TelegramCommander','Falha na verificação periódica.')}
    finally{running=false}
  }
  return {
    start(){if(timer)return;timer=setInterval(()=>void tick(),5000);timer.unref()},
    stop(){if(timer)clearInterval(timer);timer=null},
  }
}
