import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

const listener=createServer()
await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve))
const port=listener.address().port
await new Promise(resolve=>listener.close(resolve))
const dataDir=await mkdtemp(join(tmpdir(),'autoflow-stock-state-'))
const server=spawn(process.execPath,['server/server.ts'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dataDir,AUTH_SECRET:'stock-state-test-secret-32-characters-minimum',INITIAL_ADMIN_EMAIL:'stock@test.local',INITIAL_ADMIN_PASSWORD:'stock-test-password'},stdio:['ignore','pipe','pipe']})
let output='',token
server.stdout.on('data',chunk=>output+=chunk)
server.stderr.on('data',chunk=>output+=chunk)
const base=`http://127.0.0.1:${port}/api`
async function call(path,method='GET',body,expected=200,authToken=token){
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${authToken}`},body:body===undefined?undefined:JSON.stringify(body)})
  const data=await response.json()
  assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(data)}`)
  return data
}
const payload={year:2022,make:'Honda',model:'City',trim:'EXL',price:89900,km:31000,vehicleType:'Carro/picape',location:'São Paulo, SP',transmission:'Automático',fuelType:'Flex',bodyType:'Sedã',condition:'Excelente',exteriorColor:'Prateado',interiorColor:'Preto',description:'Regressão de estados de estoque',status:'Pronto'}
let accountId
async function fixture(name){
  const {id:vehicleId}=await call('/vehicles','POST',{...payload,model:name},201)
  await call(`/vehicles/${vehicleId}/images`,'POST',{name:`${name}.jpg`,mimeType:'image/jpeg',dataBase64:Buffer.concat([Buffer.from([255,216,255,224]),Buffer.from(name)]).toString('base64')},201)
  const {id:jobId}=await call('/publications','POST',{vehicleId,accountId},201)
  return {vehicleId,jobId}
}
const prepare=jobId=>call(`/extension/jobs/${jobId}/prepare`,'POST',{accountId,instanceId:'stock_state_test_instance'})
const getVehicle=async id=>(await call('/vehicles')).vehicles.find(v=>v.id===id)
const getJob=async id=>(await call('/publications')).jobs.find(j=>j.id===id)
try{
  for(let i=0;i<50;i++){
    try{if((await fetch(base+'/health')).ok)break}catch{/* aguardando processo */}
    if(server.exitCode!==null)throw new Error(output)
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  const login=await call('/auth/login','POST',{email:'stock@test.local',password:'stock-test-password'})
  token=login.token
  accountId=(await call('/social-accounts','POST',{userId:login.user.id,label:'Perfil teste',browserProfile:'Teste'},201)).id
  const pending=await fixture('Pendente')
  const sale=await call(`/vehicles/${pending.vehicleId}/mark-sold`,'POST')
  assert.equal(sale.canceledJobs,1)
  assert.equal((await getJob(pending.jobId)).status,'canceled')
  await call('/publications','POST',{vehicleId:pending.vehicleId,accountId},409)
  await call(`/extension/jobs/${pending.jobId}/prepare`,'POST',{accountId,instanceId:'stock_state_test_instance'},409)
  const firstSoldAt=(await getVehicle(pending.vehicleId)).soldAt
  await call(`/vehicles/${pending.vehicleId}/mark-sold`,'POST')
  assert.equal((await getVehicle(pending.vehicleId)).soldAt,firstSoldAt)

  // A edição começou antes da venda, mas o corpo só termina de chegar depois dela.
  const concurrent=await fixture('Edição concorrente')
  let slowRequest
  const slowResponse=new Promise((resolve,reject)=>{
    slowRequest=httpRequest(`${base}/vehicles/${concurrent.vehicleId}`,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}},response=>{
      response.resume();response.on('end',()=>resolve(response.statusCode))
    })
    slowRequest.on('error',reject)
  })
  const body=JSON.stringify({...payload,model:'Edição concorrente'})
  slowRequest.write(body.slice(0,10))
  await new Promise(resolve=>setTimeout(resolve,50))
  await call(`/vehicles/${concurrent.vehicleId}/mark-sold`,'POST')
  slowRequest.end(body.slice(10))
  assert.equal(await slowResponse,409)
  assert.equal((await getVehicle(concurrent.vehicleId)).status,'Vendido')

  const filling=await fixture('Execução em andamento')
  const task=await prepare(filling.jobId)
  await call(`/extension/jobs/${filling.jobId}/publish-check`,'POST',{leaseToken:task.leaseToken})
  assert.equal((await call(`/vehicles/${filling.vehicleId}/mark-sold`,'POST')).reviewJobs,1)
  assert.equal((await getJob(filling.jobId)).status,'awaiting_confirmation')
  await call(`/extension/jobs/${filling.jobId}/publish-check`,'POST',{leaseToken:task.leaseToken},409)
  await call(`/extension/jobs/${filling.jobId}/heartbeat`,'POST',{leaseToken:task.leaseToken},409)
  const queue=await call(`/extension/queue?accountId=${accountId}`)
  assert.ok(!queue.jobs.some(j=>j.jobId===filling.jobId||j.jobId===pending.jobId))
  await call(`/publications/${filling.jobId}`,'PATCH',{status:'pending',confirmNoPublication:true},409)
  await call('/publications/queue-state','PATCH',{ids:[filling.jobId],action:'resume'},409)
  await call('/publications/extension-visibility','PATCH',{ids:[filling.jobId],visible:true},409)
  await call(`/extension/jobs/${filling.jobId}/fill-result`,'PATCH',{leaseToken:'incorrect',published:true},409)
  await call(`/extension/jobs/${filling.jobId}/fill-result`,'PATCH',{leaseToken:task.leaseToken,published:true,resultUrl:'https://www.facebook.com/marketplace/item/1'})
  assert.equal((await getVehicle(filling.vehicleId)).status,'Vendido')
  assert.equal((await getVehicle(filling.vehicleId)).pendingRemovalCount,1)
  await call(`/publications/${filling.jobId}`,'PATCH',{status:'removed'})
  assert.equal((await getVehicle(filling.vehicleId)).status,'Vendido')
  assert.equal((await getVehicle(filling.vehicleId)).pendingRemovalCount,0)

  const interrupted=await fixture('Erro após venda')
  const interruptedTask=await prepare(interrupted.jobId)
  await call(`/vehicles/${interrupted.vehicleId}/mark-sold`,'POST')
  await call(`/extension/jobs/${interrupted.jobId}/fill-result`,'PATCH',{leaseToken:interruptedTask.leaseToken,error:'Conexão interrompida'})
  assert.equal((await getJob(interrupted.jobId)).status,'awaiting_confirmation')
  await call(`/extension/jobs/${interrupted.jobId}/fill-result`,'PATCH',{leaseToken:interruptedTask.leaseToken,published:false,publishAttempted:true})
  assert.equal((await getJob(interrupted.jobId)).fillReport.saleInterrupted,true)
  await call(`/publications/${interrupted.jobId}`,'PATCH',{status:'canceled'})
  assert.equal((await getVehicle(interrupted.vehicleId)).status,'Vendido')

  const manual=await fixture('Confirmação manual')
  const manualTask=await prepare(manual.jobId)
  await call(`/extension/jobs/${manual.jobId}/fill-result`,'PATCH',{leaseToken:manualTask.leaseToken,published:false,publishAttempted:true})
  await call(`/vehicles/${manual.vehicleId}/mark-sold`,'POST')
  await call(`/publications/${manual.jobId}`,'PATCH',{status:'completed'})
  assert.equal((await getVehicle(manual.vehicleId)).status,'Vendido')

  const unsold=await fixture('Remoção sem venda')
  const unsoldTask=await prepare(unsold.jobId)
  await call(`/extension/jobs/${unsold.jobId}/fill-result`,'PATCH',{leaseToken:unsoldTask.leaseToken,published:true})
  await call(`/publications/${unsold.jobId}`,'PATCH',{status:'removed'})
  assert.equal((await getVehicle(unsold.vehicleId)).status,'Pronto')
  // Se houver anúncios legados adicionais ativos, remover um deles não despublica o veículo.
  const db=new DatabaseSync(join(dataDir,'autoflow.db'))
  db.prepare("UPDATE vehicles SET status='Publicado' WHERE id=?").run(unsold.vehicleId)
  const insert=db.prepare("INSERT INTO publication_jobs(organization_id,vehicle_id,social_account_id,status) VALUES (?,?,?,'completed')")
  const extra=insert.run(login.user.organizationId,unsold.vehicleId,accountId)
  insert.run(login.user.organizationId,unsold.vehicleId,accountId)
  db.close()
  await call(`/publications/${Number(extra.lastInsertRowid)}`,'PATCH',{status:'removed'})
  assert.equal((await getVehicle(unsold.vehicleId)).status,'Publicado')
  console.log('OK: venda pendente/em execução, resultado tardio, confirmação manual, bloqueio de retomada, preflight e remoção consistente.')
}finally{
  if(server.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve))}
  await rm(dataDir,{recursive:true,force:true})
}
