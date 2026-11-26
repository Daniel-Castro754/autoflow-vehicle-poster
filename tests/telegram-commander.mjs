import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { telegramCommanderSettings, saveTelegramCommanderSettings, sweepTelegramCommander } from '../server/services/telegram-commander.ts'
import { formatCommanderReply, sendCommanderReply } from '../server/services/commander-telegram-reply.ts'
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
  if(method==='getMe')return {ok:true,result:{is_bot:true,username:'AutoFlowVeiculosBot',id:123}}
  lastOffset=payload.offset
  return {ok:true,result:updates}
}
const send=async(text,config,options)=>{messages.push({text,chat:config.telegramChatId,options});return true}
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
assert.throws(()=>saveTelegramCommanderSettings(db,1,{enabled:true,userIds:['100'],acknowledgeGroup:true,aiEnabled:true},credentials,now))
saveTelegramCommanderSettings(db,1,{enabled:true,userIds:['100'],acknowledgeGroup:true,aiEnabled:true,acknowledgeDeepseek:true},credentials,now)
let aiCalls=0
const answer=async(_db,org,question,guard)=>{
  assert.equal(org,1);assert(guard());assert.equal(question,'Como está o estoque?');aiCalls++
  return {text:'Resposta de teste',tools:['resumo_operacional'],status:'answered'}
}
now+=2000
updates=[update(11,'/ia pergunta',101),update(12,'/ia@OtherBot pergunta'),update(13,'/ia@AutoFlowVeiculosBot Como está o estoque?')]
await sweepTelegramCommander(db,{credentials,request,send,now:()=>now,answer})
assert.equal(aiCalls,1)
assert.equal(messages.at(-1).text,'Resposta de teste')
await sweepTelegramCommander(db,{credentials,request,send,now:()=>now,answer})
assert.equal(aiCalls,1)
messages.pop()
// Natural requests keep the same allowlist, destination, bot identity and time checks.
const natural=[]
const naturalAnswer=async(_db,org,question,guard)=>{assert.equal(org,1);assert(guard());natural.push(question);return {text:'**Resposta**',tools:['resumo_operacional'],status:'answered'}}
const naturalSweep=()=>sweepTelegramCommander(db,{credentials,request,send,now:()=>now,answer:naturalAnswer})
const ownReply={reply_to_message:{from:{id:123,is_bot:true}}}
const otherReply={reply_to_message:{from:{id:999,is_bot:true}}}
updates=[update(14,'Como está o estoque?'),update(15,'@OtherBot estoque'),update(16,'@AutoFlowVeiculosBot estoque',101),update(17,'@AutoFlowVeiculosBot estoque',100,-999),update(18,'estoque',100,-123,Math.floor(now/1000),otherReply),update(19,'/desconhecido',100,-123,Math.floor(now/1000),ownReply),update(20,'@AutoFlowVeiculosBot Como está o estoque?')]
await naturalSweep()
assert.deepEqual(natural,['Como está o estoque?'])
assert.equal(messages.at(-1).options.format,true)
messages.pop()
updates=[update(21,'E os perfis?',100,-123,Math.floor(now/1000),ownReply)]
await naturalSweep()
assert.deepEqual(natural,['Como está o estoque?','E os perfis?'])
messages.pop()
updates=[update(22,'/menu',101),update(23,'/menu',100,-999),update(24,'/menu@OtherBot'),update(25,'/menu@AutoFlowVeiculosBot',100,-123,Math.floor(now/1000),{message_id:42})]
await naturalSweep()
assert.equal(messages.length,3)
assert.deepEqual(messages.at(-1).options.menu,{messageId:42,username:'AutoFlowVeiculosBot',aiEnabled:true})
messages.pop()
const escaped=formatCommanderReply('**A < B & C** e <a href="https://example.test">link</a> e '+String.fromCharCode(96)+'x>y'+String.fromCharCode(96))
assert.equal(escaped.html,'<b>A &lt; B &amp; C</b> e &lt;a href="https://example.test"&gt;link&lt;/a&gt; e <code>x&gt;y</code>')
assert.equal(escaped.plain,'A < B & C e <a href="https://example.test">link</a> e x>y')
const originalFetch=globalThis.fetch
const sent=[]
try{
  globalThis.fetch=async(_url,init)=>{sent.push(JSON.parse(init.body));return new Response(JSON.stringify(sent.length===1?{ok:false,description:"Bad Request: can't parse entities"}:{ok:true}),{status:sent.length===1?400:200})}
  assert.equal(await sendCommanderReply('**Teste**',c,{format:true}),true)
  assert.equal(sent[0].parse_mode,'HTML')
  assert.equal(sent[0].text,'<b>Teste</b>')
  assert.equal(sent[1].parse_mode,undefined)
  assert.equal(sent[1].text,'Teste')
  await sendCommanderReply('Menu',c,{menu:{messageId:42,username:'AutoFlowVeiculosBot',aiEnabled:true}})
  const menu=sent.at(-1)
  assert.equal(menu.reply_markup.selective,true)
  assert.equal(menu.reply_parameters.message_id,42)
  assert(menu.reply_markup.keyboard.flat().every(button=>/^\/(status|ajuda|ia)@AutoFlowVeiculosBot(?: |$)/.test(button.text)))
  let networkAttempts=0
  globalThis.fetch=async()=>{networkAttempts++;throw new Error('network failure')}
  assert.equal(await sendCommanderReply('**Teste**',c,{format:true}),false)
  assert.equal(networkAttempts,1)
}finally{globalThis.fetch=originalFetch}
assert.equal(settings().memoryEnabled,false)
assert.throws(()=>saveTelegramCommanderSettings(db,1,{enabled:true,userIds:['100'],acknowledgeGroup:true,aiEnabled:true,acknowledgeDeepseek:true,memoryEnabled:true},credentials,now))
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
