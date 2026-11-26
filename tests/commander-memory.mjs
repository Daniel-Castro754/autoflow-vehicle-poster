import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { saveTelegramCommanderSettings,sweepTelegramCommander } from '../server/services/telegram-commander.ts'
import { readCommanderMemory,rememberCommanderQueries,clearAllCommanderMemory,pruneCommanderMemory } from '../server/services/commander-memory.ts'
import { answerCommanderQuestion } from '../server/services/commander-conversation.ts'
import { runCommanderQuery } from '../server/services/commander-query-tools.ts'
const db=new DatabaseSync(':memory:')
initializeBaseSchema(db);applyMigrations(db)
db.exec("INSERT INTO organizations(id,name) VALUES(1,'One'),(2,'Other'); INSERT INTO organization_settings(organization_id) VALUES(1),(2); INSERT INTO vehicles(id,organization_id,year,make,model,price,status) VALUES(1,1,2022,'VW','Nivus',108900,'Pronto'),(2,2,2022,'Private','Foreign',999999,'Pronto'); INSERT INTO publication_jobs(id,organization_id,vehicle_id,status) VALUES(1,1,1,'error'),(2,2,2,'error')")
const c={telegramBotToken:'123:fixture',telegramChatId:'-123',webhookUrl:''}
let now=Date.now()
const creds=()=>c
const settings={enabled:true,userIds:['100','101'],acknowledgeGroup:true,aiEnabled:true,acknowledgeDeepseek:true,memoryEnabled:true,acknowledgeMemory:true}
saveTelegramCommanderSettings(db,1,settings,creds,now)
const scope=userId=>({...db.prepare('SELECT destination_hash destinationHash,revision FROM telegram_commander WHERE organization_id=1').get(),userId})
const memory=scope('100')
assert.equal(rememberCommanderQueries(db,1,memory,[{tool:'consultar_veiculo',arguments:{vehicleId:1}},{tool:'executar_sql',arguments:{sql:'secret'}}],now),true)
assert.deepEqual(readCommanderMemory(db,1,memory,now)[0].references,[{tool:'consultar_veiculo',arguments:{vehicleId:1}}])
assert.deepEqual(readCommanderMemory(db,1,scope('101'),now),[])
assert.deepEqual(readCommanderMemory(db,2,memory,now),[])
assert(!JSON.stringify(db.prepare('SELECT traces FROM commander_memory').all()).includes('secret'))
for(let i=0;i<8;i++)rememberCommanderQueries(db,1,memory,[{tool:'consultar_veiculo',arguments:{vehicleId:1}}],now)
assert.equal(readCommanderMemory(db,1,memory,now).length,6)
const requests=[]
const result=await answerCommanderQuestion(db,1,'E o preço?',()=>true,{memory,now:()=>now,secrets:()=>({key:'fixture-key',redact:[]}),request:async(url,options)=>{
  const body=JSON.parse(options.body);requests.push(body)
  assert(body.messages[1].content.includes('Referências históricas'))
  assert(body.messages[1].content.includes('vehicleId'))
  if(requests.length===1)return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'a',type:'function',function:{name:'consultar_veiculo',arguments:'{"vehicleId":1}'}}]}}]})
  return Response.json({choices:[{finish_reason:'stop',message:{content:'R$ 108.900'}}]})
}})
assert.equal(result.status,'answered')
assert.deepEqual(result.references,[{tool:'consultar_veiculo',arguments:{vehicleId:1}}])
db.prepare("INSERT INTO commander_diagnostic_history(organization_id,event_id,job_id,family,business_day,claimed_at,cause,analysis_status,delivery_status) VALUES(1,1,1,'fill','2026-11-26',?,'location','analyzed','sent'),(2,2,2,'fill','2026-11-26',?,'photos','analyzed','sent')").run(now,now)
const hist=runCommanderQuery(db,1,'historico_diagnosticos',{}).data
assert.equal(hist.items.length,1)
assert.equal(hist.frequencies[0].cause,'location')
assert.equal(hist.items[0].jobStatus,'error')
assert.equal(clearAllCommanderMemory(db,1),6)
assert.deepEqual(readCommanderMemory(db,1,memory,now),[])
assert.equal(rememberCommanderQueries(db,1,memory,result.references,now),false)
const fresh=scope('100')
rememberCommanderQueries(db,1,fresh,result.references,now)
rememberCommanderQueries(db,1,scope('101'),result.references,now)
const messages=[]
const updates=[{update_id:1,message:{date:Math.floor(now/1000),text:'/limpar_memoria@AutoFlowVeiculosBot',from:{id:100,is_bot:false},chat:{id:-123,type:'group'}}}]
await sweepTelegramCommander(db,{credentials:creds,now:()=>now,request:async(_token,method)=>({ok:true,result:method==='getMe'?{is_bot:true,username:'AutoFlowVeiculosBot'}:updates}),send:async(text)=>{messages.push(text);return true}})
assert.equal(messages.length,1)
assert.equal(readCommanderMemory(db,1,fresh,now).length,0)
assert.equal(readCommanderMemory(db,1,scope('101'),now).length,1)
pruneCommanderMemory(db,now+31*86400000)
assert.equal(db.prepare('SELECT COUNT(*) n FROM commander_memory').get().n,0)
rememberCommanderQueries(db,1,fresh,result.references,now)
saveTelegramCommanderSettings(db,1,{...settings,memoryEnabled:false},creds,now)
assert.equal(db.prepare('SELECT COUNT(*) n FROM commander_memory').get().n,0)
db.close()
console.log('Commander memory: structured references, per-user and tenant scope, fresh evidence, retention, revocation, deletion and diagnostic history.')
