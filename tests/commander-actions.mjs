import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { saveTelegramCommanderSettings,sweepTelegramCommander } from '../server/services/telegram-commander.ts'
import { saveCommanderPermissionSettings,proposeCommanderPause,proposeCommanderAction,decideCommanderAction,parseCommanderSchedule } from '../server/services/commander-permissions.ts'
const db=new DatabaseSync(':memory:')
initializeBaseSchema(db);applyMigrations(db)
db.exec("INSERT INTO organizations(id,name) VALUES(1,'One'),(2,'Other'); INSERT INTO organization_settings(organization_id) VALUES(1),(2); INSERT INTO users(id,organization_id,name,email,password_hash) VALUES(1,1,'Owner','one@local','fixture'); INSERT INTO social_accounts(id,organization_id,user_id,label,status,last_seen_at) VALUES(1,1,1,'Mae','connected',CURRENT_TIMESTAMP); INSERT INTO vehicles(id,organization_id,year,make,model,price,status) VALUES(1,1,2022,'VW','Nivus',108900,'Pronto'),(2,2,2022,'Private','Foreign',999999,'Pronto'); INSERT INTO publication_jobs(id,organization_id,vehicle_id,social_account_id,status) VALUES(1,1,1,1,'pending'),(2,2,2,NULL,'pending'),(3,1,1,1,'pending'),(4,1,1,1,'pending'),(5,1,1,1,'pending'),(6,1,1,1,'pending'),(7,1,1,1,'pending'); UPDATE publication_jobs SET attempt_count=1 WHERE id=5; UPDATE publication_jobs SET status='awaiting_confirmation' WHERE id=6; UPDATE publication_jobs SET lease_token='fixture-lease' WHERE id=7")
let now=Date.now()
const c={telegramBotToken:'123:fixture',telegramChatId:'-123',webhookUrl:''}
const credentials=()=>c
saveTelegramCommanderSettings(db,1,{enabled:true,userIds:['100','101'],acknowledgeGroup:true},credentials,now)
const actor=userId=>({...db.prepare('SELECT destination_hash destinationHash,revision receiverRevision FROM telegram_commander WHERE organization_id=1').get(),userId})
const a=actor('100')
const demo={userId:'100',action:'pausar_trabalho'}
const actions=['pausar_trabalho_real','adiar_trabalho','cancelar_trabalho_pendente']
const grants=[demo,...actions.map(action=>({userId:'100',action}))]
const save=(selected,acknowledgeLive=false)=>saveCommanderPermissionSettings(db,1,1,{enabled:true,grants:selected,acknowledge:true,acknowledgeLive},credentials,now)
const code=t=>{const m=t.match(/\/autorizar ([a-f0-9]{24})/);assert(m,t);return m[1]}
const propose=(action,id,schedule=null)=>proposeCommanderAction(db,1,a,action,id,schedule,c,now)
const decide=(token,approve=true,who=a)=>decideCommanderAction(db,1,who,token,approve,c,now)
const job=id=>db.prepare('SELECT status,paused,scheduled_at scheduledAt,attempt_count attempts,retry_count retries FROM publication_jobs WHERE id=?').get(id)
save([demo])
const old=code(proposeCommanderPause(db,1,a,1,c,now))
assert(propose('pausar_trabalho_real',1).includes('não habilitada'))
assert.throws(()=>save(grants))
save(grants,true)
assert(decide(old).includes('indisponível'))
const demoToken=code(proposeCommanderPause(db,1,a,1,c,now))
assert(decide(demoToken).includes('Nenhuma ação operacional'))
assert.equal(job(1).paused,0)
for(const id of [2,5,6,7])assert(propose('cancelar_trabalho_pendente',id).includes('não elegível'))
const pause=code(propose('pausar_trabalho_real',1))
assert.equal(job(1).paused,0)
assert(decide(pause,true,actor('101')).includes('indisponível'))
assert(decide(pause).includes('Operação local executada'))
assert.equal(job(1).paused,1)
assert(decide(pause).includes('indisponível'))
const future=new Date(now+7200000).toISOString()
assert(propose('adiar_trabalho',3,new Date(now-1000).toISOString()).includes('não elegível'))
const delay=code(propose('adiar_trabalho',3,future))
assert(decide(delay).includes('Operação local executada'))
assert.equal(job(3).scheduledAt,future)
assert.equal(job(3).paused,0)
assert(propose('adiar_trabalho',3,new Date(now+3600000).toISOString()).includes('não elegível'))
assert.equal(parseCommanderSchedule('2027-02-30T19:00-03:00'),null)
assert.equal(parseCommanderSchedule('2027-02-28T19:00-03:00'),'2027-02-28T22:00:00.000Z')
const stale=code(propose('cancelar_trabalho_pendente',4))
db.exec("UPDATE publication_jobs SET attempt_count=1 WHERE id=4")
assert(decide(stale).includes('alterado'))
assert.equal(job(4).status,'pending')
db.exec("UPDATE publication_jobs SET attempt_count=0 WHERE id=4")
const messages=[]
let updates=[{update_id:1,message:{date:Math.floor(now/1000),text:'/cancelar_trabalho@AutoFlowVeiculosBot 4',from:{id:100,is_bot:false},chat:{id:-123,type:'group'}}}]
const sweep=()=>sweepTelegramCommander(db,{credentials,now:()=>now,request:async(_token,method)=>({ok:true,result:method==='getMe'?{is_bot:true,username:'AutoFlowVeiculosBot'}:updates}),send:async(text)=>{messages.push(text);return true}})
await sweep()
const cancel=code(messages[0])
assert.equal(job(4).status,'pending')
updates=[{update_id:2,message:{date:Math.floor(now/1000),text:'/autorizar@AutoFlowVeiculosBot '+cancel,from:{id:100,is_bot:false},chat:{id:-123,type:'group'}}}]
await sweep();await sweep()
assert.equal(messages.length,2)
assert.equal(job(4).status,'canceled')
assert.equal(job(4).attempts,0)
assert.equal(job(4).retries,0)
assert.equal(job(2).status,'pending')
assert.equal(db.prepare("SELECT COUNT(*) n FROM commander_action_requests WHERE status='executed'").get().n,3)
assert.equal(db.prepare("SELECT COUNT(*) n FROM publication_job_events WHERE json_extract(details,'$.source')='telegram_commander'").get().n,3)
assert.equal(db.prepare('SELECT COUNT(*) n FROM publication_listing_ledger').get().n,0)
db.close()
console.log('Commander actions: explicit live grants, demo isolation, one-shot atomic pause/postpone/cancel, stale and foreign rejection, no publication or retry changes.')
