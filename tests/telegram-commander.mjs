import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { telegramCommanderSettings, saveTelegramCommanderSettings, sweepTelegramCommander } from '../server/services/telegram-commander.ts'
const db=new DatabaseSync(':memory:')
initializeBaseSchema(db);applyMigrations(db)
db.exec("INSERT INTO organizations(id,name) VALUES(1,'One'),(2,'Other'); INSERT INTO organization_settings(organization_id) VALUES(1),(2); INSERT INTO users(id,organization_id,name,email,password_hash) VALUES(1,1,'Owner','one@local','fixture'),(2,2,'Owner','two@local','fixture'); INSERT INTO social_accounts(id,organization_id,user_id,label,status,last_seen_at) VALUES(1,1,1,'Mae','connected',CURRENT_TIMESTAMP),(2,2,2,'Foreign profile','connected',CURRENT_TIMESTAMP); INSERT INTO vehicles(id,organization_id,year,make,model) VALUES(1,1,2022,'VW','Nivus'),(2,2,2022,'Private','Other');")
const c={telegramBotToken:'123:fake_fixture',telegramChatId:'-123',webhookUrl:''}
let dest=c
const credentials=()=>dest
let now=Date.now()
const settings=()=>telegramCommanderSettings(db,1,credentials)
const save=(userIds,enabled=true)=>saveTelegramCommanderSettings(db,1,{enabled,userIds,acknowledgeGroup:true},credentials,now)
assert.equal(settings().enabled,false)
assert.throws(()=>save(['bad']))
save([])
assert.throws(()=>saveTelegramCommanderSettings(db,2,{enabled:true,userIds:['100'],acknowledgeGroup:true},credentials,now))
const messages=[]
let updates=[]
let lastOffset=0
const request=async(_token,method,payload)=>{
  if(method==='getMe')return {ok:true,result:{is_bot:true,username:'AutoFlowVeiculosBot'}}
  lastOffset=payload.offset
  return {ok:true,result:updates}
}
const send=async(text,config)=>{messages.push({text,chat:config.telegramChatId});return true}
const sweep=()=>sweepTelegramCommander(db,{credentials,request,send,now:()=>now})
const update=(id,text,user=100,chat=-123,date=Math.floor(now/1000),extra={})=>({update_id:id,message:{date,text,from:{id:user,is_bot:false},chat:{id:chat,type:'group'},...extra}})
updates=[update(1,'/status'),update(2,'/meu_id@AutoFlowVeiculosBot'),update(3,'/meu_id',100,-999)]
await sweep()
assert.equal(messages.length,1)
assert(messages[0].text.includes('100'))
save(['100'])
now+=2000
updates=[update(4,'/status@OtherBot'),update(5,'/status',101),update(6,'/status',100,-999),update(7,'/status',100,-123,Math.floor(now/1000)-180),update(8,'/status',100,-123,Math.floor(now/1000),{sender_chat:{id:-123}}),update(9,'/status@AutoFlowVeiculosBot'),update(10,'publique tudo')]
await sweep()
assert.equal(lastOffset,4)
assert.equal(messages.length,2)
assert(messages[1].text.includes('Mae')&&!messages[1].text.includes('Foreign profile'))
assert(messages[1].text.includes('não marcados como vendidos: 1'))
await sweep()
assert.equal(messages.length,2)
assert.equal(lastOffset,11)
dest={...c,telegramChatId:'-456'}
updates=[update(11,'/status',100,-456)]
await sweep()
assert.equal(messages.length,2)
assert.equal(settings().requiresRebind,true)
assert.deepEqual(settings().userIds,[])
dest=c
save(['100'],false)
await sweep()
assert.equal(messages.length,2)
db.close()
console.log('Telegram Commander: explicit authorization, tenant and destination isolation, stale/bot/foreign rejection, persistent offset and read-only replies.')
