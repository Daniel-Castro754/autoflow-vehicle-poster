import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { saveTelegramCommanderSettings,sweepTelegramCommander } from '../server/services/telegram-commander.ts'
import { commanderPermissionSettings,saveCommanderPermissionSettings,proposeCommanderPause,decideCommanderAction,pruneCommanderPermissions } from '../server/services/commander-permissions.ts'
const db=new DatabaseSync(':memory:')
initializeBaseSchema(db);applyMigrations(db)
db.exec("INSERT INTO organizations(id,name) VALUES(1,'One'),(2,'Other'); INSERT INTO organization_settings(organization_id) VALUES(1),(2); INSERT INTO vehicles(id,organization_id,year,make,model,price,status) VALUES(1,1,2022,'VW','Nivus',108900,'Pronto'),(2,2,2022,'Private','Foreign',999999,'Pronto'); INSERT INTO publication_jobs(id,organization_id,vehicle_id,status) VALUES(1,1,1,'pending'),(2,2,2,'pending')")
const c={telegramBotToken:'123:fixture',telegramChatId:'-123',webhookUrl:''}
const creds=()=>c
let now=Date.now()
const receiver={enabled:true,userIds:['100','101'],acknowledgeGroup:true}
saveTelegramCommanderSettings(db,1,receiver,creds,now)
const actor=userId=>({...db.prepare('SELECT destination_hash destinationHash,revision receiverRevision FROM telegram_commander WHERE organization_id=1').get(),userId})
const settings=()=>commanderPermissionSettings(db,1,creds,now)
const grant={userId:'100',action:'pausar_trabalho'}
const save=(enabled=true,grants=[grant])=>saveCommanderPermissionSettings(db,1,1,{enabled,grants,acknowledge:true},creds,now)
const propose=(job=1,a=actor('100'))=>proposeCommanderPause(db,1,a,job,c,now)
const decide=(token,approve=true,a=actor('100'))=>decideCommanderAction(db,1,a,token,approve,c,now)
const code=text=>{const match=text.match(/\/autorizar ([a-f0-9]{24})/);assert(match,text);return match[1]}
assert.equal(settings().enabled,false)
assert(propose().includes('não habilitada'))
assert.throws(()=>save(true,[{userId:'999',action:'pausar_trabalho'}]))
assert.throws(()=>save(true,[{userId:'100',action:'executar_sql'}]))
save()
assert(propose(2).includes('não elegível'))
assert(propose(1,actor('101')).includes('não habilitada'))
const token=code(propose())
assert(!JSON.stringify(settings()).includes(token))
assert(!JSON.stringify(db.prepare('SELECT * FROM commander_action_requests').all()).includes(token))
assert(decide(token,true,actor('101')).includes('indisponível'))
assert(decideCommanderAction(db,2,actor('100'),token,true,c,now).includes('indisponível'))
assert(decide(token).includes('Nenhuma ação operacional'))
assert(decide(token).includes('indisponível'))
assert.equal(db.prepare('SELECT paused FROM publication_jobs WHERE id=1').get().paused,0)
const stale=code(propose())
db.exec("UPDATE publication_jobs SET scheduled_at='2027-01-01T12:00:00Z' WHERE id=1")
assert(decide(stale).includes('alterado'))
const expired=code(propose())
now+=301000
assert(decide(expired).includes('vencida'))
const rejected=code(propose())
assert(decide(rejected,false).includes('recusada'))
const revoked=code(propose())
save(false)
assert(decide(revoked).includes('indisponível'))
save()
let messages=[],updates=[]
const request=async(_token,method)=>({ok:true,result:method==='getMe'?{is_bot:true,username:'AutoFlowVeiculosBot'}:updates})
const send=async(text)=>{messages.push(text);return true}
const update=(id,text,user=100,chat=-123)=>({update_id:id,message:{date:Math.floor(now/1000),text,from:{id:user,is_bot:false},chat:{id:chat,type:'group'}}})
const sweep=()=>sweepTelegramCommander(db,{credentials:creds,request,send,now:()=>now})
updates=[update(1,'/solicitar_pausa 1',100,-999),update(2,'/solicitar_pausa@OtherBot 1'),update(3,'/solicitar_pausa@AutoFlowVeiculosBot 1')]
await sweep()
assert.equal(messages.length,1)
const telegramCode=code(messages[0])
updates=[update(4,'/autorizar '+telegramCode,101),update(5,'/autorizar@AutoFlowVeiculosBot '+telegramCode)]
await sweep()
assert.equal(messages.length,3)
assert(messages[2].includes('Nenhuma ação operacional'))
await sweep()
assert.equal(messages.length,3)
const old=code(propose())
saveTelegramCommanderSettings(db,1,{...receiver,userIds:['100']},creds,now)
assert.equal(settings().enabled,false)
assert(decide(old).includes('revogada'))
assert.equal(db.prepare('SELECT paused FROM publication_jobs WHERE id=1').get().paused,0)
assert.equal(db.prepare('SELECT COUNT(*) n FROM commander_permission_audit WHERE organization_id=1').get().n,3)
pruneCommanderPermissions(db,now+91*86400000)
assert.equal(db.prepare('SELECT COUNT(*) n FROM commander_action_requests').get().n,0)
db.close()
console.log('Commander permissions: deny by default, scoped grants, exact sender/destination, expiring one-shot preview, stale/revoked rejection, audit and no job mutation.')
