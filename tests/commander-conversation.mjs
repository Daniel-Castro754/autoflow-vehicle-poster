import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { answerCommanderQuestion, commanderUsage } from '../server/services/commander-conversation.ts'
const db=new DatabaseSync(':memory:')
initializeBaseSchema(db);applyMigrations(db)
db.exec("INSERT INTO organizations(id,name) VALUES(1,'One'),(2,'Other'); INSERT INTO vehicles(id,organization_id,year,make,model,price,status) VALUES(1,1,2022,'VW','Nivus',108900,'Pronto'),(2,2,2022,'Private','Foreign',999999,'Pronto')")
const secrets=()=>({key:'test-deepseek-private-key',redact:['test-other-secret']})
const requests=[]
let mode='normal'
let authorized=true
const request=async(url,options)=>{
  assert.equal(url,'https://api.deepseek.com/chat/completions')
  assert.equal(options.redirect,'error')
  const body=JSON.parse(options.body)
  requests.push(body)
  assert(!options.body.includes('test-deepseek-private-key'))
  assert(!options.body.includes('test-other-secret'))
  assert(!options.body.includes('999999'))
  assert(body.tools.every(t=>t.type==='function'))
  if(mode==='http')return new Response('test-deepseek-private-key',{status:429})
  if(mode==='unauthorize')authorized=false
  if(mode==='bad')return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'a',type:'function',function:{name:'executar_sql',arguments:'{}'}}]}}]})
  if(mode==='noevidence')return Response.json({choices:[{finish_reason:'stop',message:{content:'Inventado'}}]})
  if(body.messages.some(m=>m.role==='tool')){
    const evidence=JSON.parse(body.messages.find(m=>m.role==='tool').content)
    assert.equal(evidence.data.stock.stockValue,108900)
    return Response.json({choices:[{finish_reason:'stop',message:{content:'Estoque de R$ 108.900.'}}]})
  }
  return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'call_1',type:'function',function:{name:'resumo_operacional',arguments:'{}'}}]}}]})
}
const ask=(question='Qual o valor do estoque?')=>answerCommanderQuestion(db,1,question,()=>authorized,{secrets,request})
const answer=await ask()
assert.equal(answer.status,'answered')
assert.deepEqual(answer.tools,['resumo_operacional'])
assert(answer.text.includes('108.900'))
assert.equal(requests.length,2)
assert.equal(commanderUsage(db,1).used,1)
assert.equal(commanderUsage(db,2).used,0)
assert.equal((await ask('test-deepseek-private-key')).status,'blocked')
assert.equal(requests.length,2)
mode='bad'
assert.equal((await ask()).status,'blocked')
mode='noevidence'
assert.equal((await ask()).status,'unavailable')
mode='http'
assert(!(await ask()).text.includes('test-deepseek-private-key'))
mode='unauthorize'
assert.equal((await ask()).status,'blocked')
authorized=true
mode='http'
while(commanderUsage(db,1).used<20)await ask()
const before=requests.length
assert.equal((await ask()).status,'limited')
assert.equal(requests.length,before)
assert.equal(db.prepare('SELECT COUNT(*) n FROM vehicles').get().n,2)
db.close()
console.log('Commander conversation: real tool protocol mocked, tenant scope, evidence requirement, secret filtering, authorization recheck, persistent budget and no mutation of inventory.')
