import type { DatabaseSync } from 'node:sqlite'
import { createHash,randomBytes } from 'node:crypto'
import { getAlertCredentials } from './credential-vault.ts'
import { publicationMayExist } from './publication-evidence.ts'
import { openResultConflict } from './result-conflicts.ts'
import { releaseUnpublishedHash } from './duplicate-checker.ts'
import { parseSqliteTimestamp } from './profile-capacity.ts'

export const commanderActionCatalog=[
  {name:'pausar_trabalho',description:'Demonstração: validar pausa sem executar.',mode:'preview_only'},
  {name:'pausar_trabalho_real',description:'Pausar trabalho pendente ainda não iniciado.',mode:'execute_once'},
  {name:'adiar_trabalho',description:'Definir horário futuro ou adiar trabalho pendente ainda não iniciado, sem antecipar.',mode:'execute_once'},
  {name:'cancelar_trabalho_pendente',description:'Cancelar somente trabalho pendente nunca executado. Não retira anúncio do Facebook.',mode:'execute_once'},
] as const
type Action=typeof commanderActionCatalog[number]['name']
type LiveAction=Exclude<Action,'pausar_trabalho'>
type Grant={userId:string;action:Action}
type Credentials={telegramBotToken:string;telegramChatId:string}
type CredentialReader=(db:DatabaseSync,org:number)=>Credentials
type Receiver={enabled:number;user_ids:string;destination_hash:string;revision:number}
type Policy={enabled:number;grants:string;destination_hash:string;receiver_revision:number;revision:number}
export type CommanderActor={userId:string;destinationHash:string;receiverRevision:number}
type RequestRow={id:number;telegram_user_id:string;action:Action;job_id:number;destination_hash:string;receiver_revision:number;policy_revision:number;snapshot_hash:string;expires_at:number;status:string;mode:string;scheduled_at:string|null}
const ttl=5*60000
const retention=90*86400000
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const destination=(c:Credentials)=>hash(JSON.stringify([c.telegramBotToken,c.telegramChatId]))
const configured=(c:Credentials)=>/^\d+:[A-Za-z0-9_-]+$/.test(c.telegramBotToken)&&/^-\d+$/.test(c.telegramChatId)
const receiver=(db:DatabaseSync,org:number)=>db.prepare('SELECT enabled,user_ids,destination_hash,revision FROM telegram_commander WHERE organization_id=?').get(org) as Receiver|undefined
const policy=(db:DatabaseSync,org:number)=>db.prepare('SELECT * FROM commander_permission_policy WHERE organization_id=?').get(org) as Policy|undefined
const validUser=(s:unknown):s is string=>typeof s==='string'&&/^[1-9]\d{0,15}$/.test(s)&&Number.isSafeInteger(Number(s))
const validAction=(s:unknown):s is Action=>commanderActionCatalog.some(a=>a.name===s)
function users(r:Receiver|undefined):string[]{
  try{const v:unknown=JSON.parse(r?.user_ids||'[]');return Array.isArray(v)?v.filter(validUser):[]}catch{return []}
}
function grants(raw:unknown):Grant[]{
  if(!Array.isArray(raw)||raw.length>40)throw new Error('Permissões inválidas.')
  const result:Grant[]=[]
  for(const g of raw){
    if(!g||typeof g!=='object'||Array.isArray(g)||Object.keys(g).some(k=>!['userId','action'].includes(k))||!validUser(g.userId)||!validAction(g.action))throw new Error('Permissão inválida.')
    if(!result.some(x=>x.userId===g.userId&&x.action===g.action))result.push({userId:g.userId,action:g.action})
  }
  return result.sort((a,b)=>a.userId.localeCompare(b.userId)||a.action.localeCompare(b.action))
}
function storedGrants(p:Policy|undefined):Grant[]{try{return grants(JSON.parse(p?.grants||'[]'))}catch{return []}}
function bound(r:Receiver|undefined,p:Policy|undefined,c:Credentials){
  return Boolean(r?.enabled&&p?.enabled&&configured(c)&&r.destination_hash===destination(c)&&p.destination_hash===r.destination_hash&&p.receiver_revision===r.revision)
}
function permitted(db:DatabaseSync,org:number,actor:CommanderActor,action:Action,c:Credentials){
  const r=receiver(db,org),p=policy(db,org)
  if(!p||!r||!bound(r,p,c)||actor.destinationHash!==r.destination_hash||actor.receiverRevision!==r.revision||!users(r).includes(actor.userId)||!storedGrants(p).some(g=>g.userId===actor.userId&&g.action===action))return null
  return p
}
export function commanderPermissionSettings(db:DatabaseSync,org:number,credentials:CredentialReader=getAlertCredentials,now=Date.now()){
  const r=receiver(db,org),p=policy(db,org),c=credentials(db,org)
  const active=bound(r,p,c)
  const requests=db.prepare('SELECT id,telegram_user_id userId,action,job_id jobId,created_at createdAt,expires_at expiresAt,decided_at decidedAt,status,mode,scheduled_at scheduledAt FROM commander_action_requests WHERE organization_id=? AND created_at>=? ORDER BY id DESC LIMIT 30').all(org,now-retention).map(row=>({...row,status:row.status==='pending'&&Number(row.expiresAt)<=now?'expired':row.status==='pending'&&(!active||!db.prepare('SELECT 1 FROM commander_action_requests WHERE id=? AND receiver_revision=? AND policy_revision=? AND destination_hash=?').get(row.id,r?.revision||0,p?.revision||0,r?.destination_hash||''))?'revoked':row.status}))
  return {enabled:active,requiresRebind:Boolean(p?.enabled&&!active),userIds:r?.enabled&&configured(c)&&r.destination_hash===destination(c)?users(r):[],grants:active?storedGrants(p):[],catalog:commanderActionCatalog,requests,expiresMinutes:5,mode:'mixed'}
}
export function saveCommanderPermissionSettings(db:DatabaseSync,org:number,admin:number,input:unknown,credentials:CredentialReader=getAlertCredentials,now=Date.now()){
  const v=input as {enabled?:unknown;grants?:unknown;acknowledge?:unknown;acknowledgeLive?:unknown}|null
  if(!v||typeof v.enabled!=='boolean'||!Number.isSafeInteger(admin)||admin<1)throw new Error('Configuração inválida.')
  const chosen=grants(v.grants),c=credentials(db,org)
  if(v.enabled&&chosen.some(g=>g.action!=='pausar_trabalho')&&v.acknowledgeLive!==true)throw new Error('Confirme explicitamente as operações reais.')
  db.exec('BEGIN IMMEDIATE')
  try{
    const r=receiver(db,org),p=policy(db,org)
    if(v.enabled&&(!r?.enabled||!configured(c)||r.destination_hash!==destination(c)||v.acknowledge!==true||!chosen.length||chosen.some(g=>!users(r).includes(g.userId))))throw new Error('Autorize os usuários no receptor e confirme as permissões.')
    const selected=v.enabled?chosen:[],fingerprint=v.enabled?r!.destination_hash:'',revision=v.enabled?r!.revision:0
    if(!p||p.enabled!==Number(v.enabled)||p.destination_hash!==fingerprint||p.receiver_revision!==revision||JSON.stringify(storedGrants(p))!==JSON.stringify(selected)){
      db.prepare('INSERT INTO commander_permission_policy(organization_id,enabled,grants,destination_hash,receiver_revision,revision) VALUES(?,?,?,?,?,1) ON CONFLICT(organization_id) DO UPDATE SET enabled=excluded.enabled,grants=excluded.grants,destination_hash=excluded.destination_hash,receiver_revision=excluded.receiver_revision,revision=commander_permission_policy.revision+1').run(org,Number(v.enabled),JSON.stringify(selected),fingerprint,revision)
      db.prepare("UPDATE commander_action_requests SET status='revoked',decided_at=? WHERE organization_id=? AND status='pending'").run(now,org)
      db.prepare('INSERT INTO commander_permission_audit(organization_id,admin_user_id,enabled,grants,created_at) VALUES(?,?,?,?,?)').run(org,admin,Number(v.enabled),JSON.stringify(selected),now)
    }
    db.exec('COMMIT')
  }catch(error){db.exec('ROLLBACK');throw error}
  return commanderPermissionSettings(db,org,credentials,now)
}
// This preview only uses a pending, unleased job with no ambiguous publication.
function pauseSnapshot(db:DatabaseSync,org:number,jobId:number){
  const j=db.prepare("SELECT j.id,j.vehicle_id vehicleId,j.social_account_id accountId,j.status,j.paused,j.extension_visible visible,j.scheduled_at scheduledAt,j.updated_at updatedAt,j.lease_token leaseToken,j.publish_attempt_at publishAttemptAt,j.fill_report fillReport,v.status vehicleStatus,v.sold_at soldAt FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id AND v.organization_id=j.organization_id WHERE j.organization_id=? AND j.id=?").get(org,jobId)
  if(!j||j.status!=='pending'||j.paused!==0||j.leaseToken||j.soldAt||j.vehicleStatus==='Vendido'||publicationMayExist(j)||openResultConflict(db,org,jobId))return null
  const event=db.prepare('SELECT COALESCE(MAX(id),0) n FROM publication_job_events WHERE organization_id=? AND publication_job_id=?').get(org,jobId)?.n
  return {digest:hash(JSON.stringify([j,event])),vehicleId:j.vehicleId,accountId:j.accountId,scheduledAt:j.scheduledAt}
}
// Only never-started local work is eligible for real operations. No new
// publication, requeue, retry, resume, limit change or external action here.
function liveSnapshot(db:DatabaseSync,org:number,jobId:number,action:LiveAction,scheduledAt:string|null,now:number){
  const j=db.prepare("SELECT j.id,j.vehicle_id vehicleId,j.social_account_id accountId,j.status,j.paused,j.extension_visible visible,j.scheduled_at scheduledAt,j.updated_at updatedAt,j.lease_token leaseToken,j.lease_owner leaseOwner,j.lease_expires_at leaseExpiresAt,j.last_lease_token lastLeaseToken,j.publish_attempt_at publishAttemptAt,j.fill_report fillReport,j.started_at startedAt,j.filled_at filledAt,j.attempt_count attempts,j.retry_count retries,j.result_url resultUrl,j.error_code errorCode,v.status vehicleStatus,v.sold_at soldAt FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id AND v.organization_id=j.organization_id WHERE j.organization_id=? AND j.id=?").get(org,jobId)
  if(!j||j.status!=='pending'||j.leaseToken||j.leaseOwner||j.leaseExpiresAt||j.lastLeaseToken||j.startedAt||j.filledAt||j.resultUrl||j.errorCode||j.attempts!==0||j.retries!==0||j.soldAt||j.vehicleStatus==='Vendido'||publicationMayExist(j)||openResultConflict(db,org,jobId))return null
  if(j.fillReport&&j.fillReport!==''&&j.fillReport!=='{}')return null
  if(db.prepare("SELECT 1 FROM publication_job_events WHERE organization_id=? AND publication_job_id=? AND event_type IN ('filling_started','auto_published','late_publish_confirmed','confirmed_published','filled_waiting_confirmation','publish_result_unknown','fill_error','fill_result_conflict') LIMIT 1").get(org,jobId))return null
  if(db.prepare('SELECT 1 FROM publication_listing_ledger WHERE organization_id=? AND publication_job_id=? LIMIT 1').get(org,jobId))return null
  if(db.prepare("SELECT 1 FROM published_ads WHERE organization_id=? AND publication_job_id=? AND status!='queued' LIMIT 1").get(org,jobId))return null
  if(action==='pausar_trabalho_real'&&j.paused!==0)return null
  if(action==='adiar_trabalho'){
    const target=parseSqliteTimestamp(scheduledAt)
    const previous=parseSqliteTimestamp(typeof j.scheduledAt==='string'?j.scheduledAt:null)
    if(target===null||target<now+60000||target>now+30*86400000||(j.scheduledAt&&previous===null)||(previous!==null&&target<=previous))return null
    // A postponed job keeps its current pause/visibility and all execution gates.
    if(j.accountId==null||!db.prepare('SELECT 1 FROM social_accounts WHERE organization_id=? AND id=?').get(org,j.accountId))return null
  }else if(scheduledAt!==null)return null
  const event=db.prepare('SELECT COALESCE(MAX(id),0) n FROM publication_job_events WHERE organization_id=? AND publication_job_id=?').get(org,jobId)?.n
  return {digest:hash(JSON.stringify([j,event,action,scheduledAt])),vehicleId:j.vehicleId,accountId:j.accountId,scheduledAt:j.scheduledAt}
}
export function parseCommanderSchedule(raw:string){
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}-03:00$/.test(raw))return null
  const time=Date.parse(raw)
  if(!Number.isFinite(time)||new Date(time-3*3600000).toISOString().slice(0,16)!==raw.slice(0,16))return null
  return new Date(time).toISOString()
}
export function proposeCommanderPause(db:DatabaseSync,org:number,actor:CommanderActor,jobId:number,c:Credentials,now=Date.now()){
  return proposeCommanderAction(db,org,actor,'pausar_trabalho',jobId,null,c,now)
}
export function proposeCommanderAction(db:DatabaseSync,org:number,actor:CommanderActor,action:Action,jobId:number,scheduledAt:string|null,c:Credentials,now=Date.now()){
  if(!validAction(action)||!Number.isSafeInteger(jobId)||jobId<1)return 'ID de trabalho inválido.'
  db.exec('BEGIN IMMEDIATE')
  try{
    const p=permitted(db,org,actor,action,c)
    let text='Permissão de ação não habilitada para este usuário.'
    if(p){
      const demo=action==='pausar_trabalho'
      const snapshot=demo?(scheduledAt===null?pauseSnapshot(db,org,jobId):null):liveSnapshot(db,org,jobId,action,scheduledAt,now)
      const total=Number(db.prepare('SELECT COUNT(*) n FROM commander_action_requests WHERE organization_id=? AND created_at>?').get(org,now-86400000)?.n||0)
      const pending=Number(db.prepare("SELECT COUNT(*) n FROM commander_action_requests WHERE organization_id=? AND telegram_user_id=? AND status='pending' AND expires_at>? AND policy_revision=? AND receiver_revision=?").get(org,actor.userId,now,p.revision,actor.receiverRevision)?.n||0)
      if(!snapshot)text='Trabalho não elegível para esta proposta. Consulte o status e revise no painel.'
      else if(total>=30||pending>=3)text='Limite de solicitações atingido. Aguarde o vencimento ou recuse uma proposta pendente.'
      else{
        const token=randomBytes(12).toString('hex')
        db.prepare('INSERT INTO commander_action_requests(organization_id,telegram_user_id,action,job_id,token_hash,destination_hash,receiver_revision,policy_revision,snapshot_hash,created_at,expires_at,mode,scheduled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(org,actor.userId,action,jobId,hash(token),actor.destinationHash,actor.receiverRevision,p.revision,snapshot.digest,now,now+ttl,demo?'preview_only':'execute_once',scheduledAt)
        const label=action==='adiar_trabalho'?'adiar':action==='cancelar_trabalho_pendente'?'cancelar':'pausar'
        text=['🔐 Solicitação de autorização — '+(demo?'demonstração':'OPERAÇÃO REAL'),'Ação: '+label+' trabalho #'+jobId,'Veículo #'+snapshot.vehicleId+' · perfil #'+(snapshot.accountId??'não definido'),'Status atual: pendente.',
          ...(scheduledAt?['Novo horário mínimo (Brasília): '+new Date(scheduledAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})]:[]),
          'Validade: 5 minutos. Somente o solicitante pode decidir.','/autorizar '+token,'/recusar '+token,
          demo?'Esta etapa registra a decisão; NÃO pausa nem altera o trabalho.':'A confirmação altera a fila local. Não publica nem retira anúncios no Facebook.'].join('\n')
      }
    }
    db.exec('COMMIT');return text
  }catch(error){db.exec('ROLLBACK');throw error}
}
export function decideCommanderAction(db:DatabaseSync,org:number,actor:CommanderActor,token:string,approve:boolean,c:Credentials,now=Date.now()){
  if(!/^[a-f0-9]{24}$/.test(token))return 'Solicitação indisponível.'
  db.exec('BEGIN IMMEDIATE')
  try{
    const row=db.prepare('SELECT * FROM commander_action_requests WHERE organization_id=? AND telegram_user_id=? AND token_hash=?').get(org,actor.userId,hash(token)) as RequestRow|undefined
    let text='Solicitação indisponível.'
    if(row&&row.status==='pending'){
      const p=permitted(db,org,actor,row.action,c)
      let status:string
      if(!p||p.revision!==row.policy_revision||actor.receiverRevision!==row.receiver_revision||actor.destinationHash!==row.destination_hash)status='revoked'
      else if(row.expires_at<=now)status='expired'
      else if(!approve)status='rejected'
      else if(row.mode==='preview_only'){
        status=row.action==='pausar_trabalho'&&pauseSnapshot(db,org,row.job_id)?.digest===row.snapshot_hash?'validated_only':'stale'
      }else if(row.mode==='execute_once'&&validAction(row.action)&&row.action!=='pausar_trabalho'&&liveSnapshot(db,org,row.job_id,row.action,row.scheduled_at,now)?.digest===row.snapshot_hash){
        // Transaction and snapshot recheck bind the decision to this exact job.
        // No asynchronous operation, model output or raw command is executed.
        const changed=row.action==='pausar_trabalho_real'
          ?db.prepare("UPDATE publication_jobs SET paused=1,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND id=? AND status='pending' AND lease_token IS NULL").run(org,row.job_id)
          :row.action==='adiar_trabalho'
            ?db.prepare("UPDATE publication_jobs SET scheduled_at=?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND id=? AND status='pending' AND lease_token IS NULL").run(row.scheduled_at,org,row.job_id)
            :db.prepare("UPDATE publication_jobs SET status='canceled',updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND id=? AND status='pending' AND lease_token IS NULL").run(org,row.job_id)
        if(!changed.changes)status='stale'
        else{
          if(row.action==='cancelar_trabalho_pendente')releaseUnpublishedHash(db,org,row.job_id)
          const event=row.action==='pausar_trabalho_real'?'paused':row.action==='adiar_trabalho'?'scheduled':'canceled'
          db.prepare('INSERT INTO publication_job_events(organization_id,publication_job_id,event_type,details) VALUES(?,?,?,?)').run(org,row.job_id,event,JSON.stringify({source:'telegram_commander',requestId:row.id,telegramUserId:actor.userId,...(row.scheduled_at?{scheduledAt:row.scheduled_at}:{})}))
          status='executed'
        }
      }else status='stale'
      db.prepare("UPDATE commander_action_requests SET status=?,decided_at=? WHERE organization_id=? AND id=? AND status='pending'").run(status,now,org,row.id)
      text=status==='executed'?'✅ Operação local executada: '+row.action+' — trabalho #'+row.job_id+'. Não houve publicação nem retirada no Facebook.':status==='validated_only'?'✅ Autorização validada para a proposta do trabalho #'+row.job_id+'. Nenhuma ação operacional foi executada.':status==='rejected'?'Solicitação recusada.':status==='stale'?'Trabalho alterado desde a proposta. Solicite outra após revisar o estado.':status==='expired'?'Solicitação vencida.':'Solicitação revogada.'
    }
    db.exec('COMMIT');return text
  }catch(error){db.exec('ROLLBACK');throw error}
}
export function pruneCommanderPermissions(db:DatabaseSync,now=Date.now()){
  db.prepare("UPDATE commander_action_requests SET status='expired',decided_at=? WHERE status='pending' AND expires_at<=?").run(now,now)
  db.prepare('DELETE FROM commander_action_requests WHERE id IN (SELECT id FROM commander_action_requests WHERE created_at<? LIMIT 5000)').run(now-retention)
  db.prepare('DELETE FROM commander_permission_audit WHERE id IN (SELECT id FROM commander_permission_audit WHERE created_at<? LIMIT 5000)').run(now-retention)
}
