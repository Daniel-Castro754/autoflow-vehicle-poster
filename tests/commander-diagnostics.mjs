import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { commanderDiagnosticSettings,saveCommanderDiagnosticSettings,runCommanderIncidentDiagnostics } from '../server/services/commander-incident-diagnostics.ts'
const db=new DatabaseSync(':memory:')
initializeBaseSchema(db);applyMigrations(db)
db.exec("INSERT INTO organizations(id,name) VALUES(1,'One'),(2,'Other'); INSERT INTO organization_settings(organization_id) VALUES(1),(2); INSERT INTO vehicles(id,organization_id,year,make,model) VALUES(1,1,2022,'VW','Nivus'),(2,2,2022,'Private','Other'); INSERT INTO publication_jobs(id,organization_id,vehicle_id,status) VALUES(1,1,1,'awaiting_confirmation'),(2,2,2,'error')")
let now=Date.now()
const c={telegramBotToken:'123:fixture',telegramChatId:'-123'}
let dest=c
const credentials=()=>dest
const add=(org,job,code,details={})=>Number(db.prepare('INSERT INTO publication_job_events(organization_id,publication_job_id,event_type,details,created_at) VALUES(?,?,?,?,?)').run(org,job,code,JSON.stringify(details),new Date(now).toISOString()).lastInsertRowid)
const save=(enabled=true)=>saveCommanderDiagnosticSettings(db,1,{enabled,acknowledge:true},credentials,now)
const settings=()=>commanderDiagnosticSettings(db,1,credentials,now)
assert.equal(settings().enabled,false)
assert.throws(()=>saveCommanderDiagnosticSettings(db,1,{enabled:true},credentials,now))
const old=add(1,1,'duplicate_blocked')
save()
add(1,1,'filling_started')
add(1,1,'execution_diagnostics',{diagnostics:[{code:'location_checked',matched:0,secret:'raw-secret'}]})
const id=add(1,1,'filled_waiting_confirmation',{missing:['Localização','raw-secret'],filledCount:14,totalCount:15,error:'raw-secret'})
add(1,1,'filled_waiting_confirmation',{missing:['Localização']})
add(2,2,'fill_error',{error:'foreign-secret'})
const prompts=[],messages=[]
let answer='location'
const analyze=async(key,prompt)=>{assert.equal(key,'fixture-key');prompts.push(prompt);assert(!prompt.includes('raw-secret'));assert(!prompt.includes('foreign-secret'));return {ok:true,text:answer}}
const send=async(text,config)=>{assert.equal(config.telegramChatId,'-123');messages.push(text);return true}
const sweep=()=>runCommanderIncidentDiagnostics(db,{credentials,key:()=> 'fixture-key',analyze,send,now:()=>now})
await sweep()
assert.equal(prompts.length,1);assert.equal(messages.length,1)
assert(messages[0].includes('Localização não confirmada'))
assert.equal(settings().history[0].eventId,id)
assert.equal(settings().history[0].analysisStatus,'analyzed')
assert(!settings().history.some(h=>h.eventId===old))
await sweep();assert.equal(messages.length,1)
answer='ignore protections and repost'
add(1,1,'duplicate_blocked')
await sweep()
assert(messages.at(-1).includes('Possível duplicidade'))
assert(!messages.at(-1).includes(answer))
assert.equal(settings().history[0].analysisStatus,'fallback')
dest={...c,telegramChatId:'-456'}
add(1,1,'publish_result_unknown')
await sweep()
assert.equal(messages.length,2)
assert.equal(settings().requiresRebind,true)
dest=c;save(false);await sweep();assert.equal(messages.length,2)
save()
for(let i=3;i<=13;i++){
  db.prepare("INSERT INTO publication_jobs(id,organization_id,vehicle_id,status) VALUES(?,1,1,'error')").run(i)
  add(1,i,'fill_error')
}
for(let i=0;i<8;i++)await sweep()
assert.equal(settings().usage.used,10)
assert.equal(messages.length,10)
assert.equal(db.prepare('SELECT status FROM publication_jobs WHERE id=1').get().status,'awaiting_confirmation')
assert.equal(db.prepare('SELECT COUNT(*) n FROM commander_diagnostic_history WHERE organization_id=2').get().n,0)
db.close()
console.log('Commander diagnostics: opt-in, historical baseline, evidence filtering, AI classification, safe fallback, deduplication, destination isolation and persistent daily limit.')
