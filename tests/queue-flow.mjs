import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port=3399
const base=`http://127.0.0.1:${port}/api`
const dataDir=await mkdtemp(join(tmpdir(),'autoflow-queue-test-'))
const server=spawn(process.execPath,['server/server.ts'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),DATA_DIR:dataDir,AUTH_SECRET:'queue-test-secret'},stdio:['ignore','pipe','pipe']})
let serverOutput=''
server.stdout.on('data',chunk=>serverOutput+=chunk)
server.stderr.on('data',chunk=>serverOutput+=chunk)

async function waitForServer(){for(let attempt=0;attempt<40;attempt++){try{const response=await fetch(base+'/health');if(response.ok)return}catch{}await new Promise(resolve=>setTimeout(resolve,100))}throw new Error(`A API de teste não iniciou. ${serverOutput}`)}
async function login(email){const response=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'demo1234'})});const data=await response.json();if(!response.ok)throw new Error(data.error);return data.token}
async function call(path,token,options={}){const response=await fetch(base+path,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}});const data=await response.json();if(!response.ok)throw Object.assign(new Error(`${response.status} ${path}: ${data.error}`),{status:response.status});return data}
async function expectStatus(status,operation){try{await operation();throw new Error(`A operação deveria responder ${status}.`)}catch(error){if(error.status!==status)throw error}}

try{
  await waitForServer()
  const adminToken=await login('admin@autoflow.local')
  const sellerToken=await login('marina@autoflow.local')
  const team=await call('/team',adminToken)
  const admin=team.users.find(user=>user.email==='admin@autoflow.local')
  const marina=team.users.find(user=>user.email==='marina@autoflow.local')
  const first=await call('/social-accounts',adminToken,{method:'POST',body:JSON.stringify({userId:admin.id,label:'Facebook Daniel',browserProfile:'Brave Perfil 1'})})
  const second=await call('/social-accounts',adminToken,{method:'POST',body:JSON.stringify({userId:marina.id,label:'Facebook Marina',browserProfile:'Brave Perfil 2'})})
  await expectStatus(403,()=>call('/social-accounts',sellerToken,{method:'POST',body:JSON.stringify({userId:marina.id,label:'Não permitido',browserProfile:'Brave Perfil 3'})}))
  const sellerAccounts=await call('/extension/accounts',sellerToken)
  if(sellerAccounts.accounts.length!==1||sellerAccounts.accounts[0].id!==second.id)throw new Error('O vendedor recebeu perfis de outro usuário.')
  await expectStatus(403,()=>call(`/extension/queue?accountId=${first.id}`,sellerToken))
  const publication=await call('/publications',adminToken,{method:'POST',body:JSON.stringify({vehicleId:1,accountId:first.id})})
  const firstQueue=await call(`/extension/queue?accountId=${first.id}`,adminToken)
  const secondQueue=await call(`/extension/queue?accountId=${second.id}`,adminToken)
  if(firstQueue.jobs.length!==1||firstQueue.jobs[0].jobId!==publication.id)throw new Error('O trabalho não apareceu no perfil correto.')
  if(secondQueue.jobs.length!==0)throw new Error('O trabalho vazou para outro perfil.')
  const prepared=await call(`/extension/jobs/${publication.id}/prepare`,adminToken,{method:'POST',body:JSON.stringify({accountId:first.id})})
  await call(`/extension/jobs/${publication.id}/fill-result`,adminToken,{method:'PATCH',body:JSON.stringify({filledCount:12,totalCount:13,imageCount:7,missing:['Cor'],fields:[{name:'Cor',ok:false}],extensionVersion:'0.3.0'})})
  let job=(await call('/publications',adminToken)).jobs.find(item=>item.id===publication.id)
  if(job.status!=='awaiting_confirmation'||job.fillReport?.missing?.[0]!=='Cor')throw new Error('O relatório de preenchimento não foi persistido.')
  await call(`/publications/${publication.id}`,adminToken,{method:'PATCH',body:JSON.stringify({status:'pending'})})
  job=(await call('/publications',adminToken)).jobs.find(item=>item.id===publication.id)
  if(job.fillReport||job.errorCode)throw new Error('A repetição não limpou o diagnóstico anterior.')
  await call(`/extension/jobs/${publication.id}/prepare`,adminToken,{method:'POST',body:JSON.stringify({accountId:first.id})})
  await call(`/extension/jobs/${publication.id}/fill-result`,adminToken,{method:'PATCH',body:JSON.stringify({filledCount:13,totalCount:13,imageCount:7,missing:[],fields:[],extensionVersion:'0.3.0'})})
  await call(`/publications/${publication.id}`,adminToken,{method:'PATCH',body:JSON.stringify({status:'completed'})})
  job=(await call('/publications',adminToken)).jobs.find(item=>item.id===publication.id)
  const vehicle=(await call('/vehicles',adminToken)).vehicles.find(item=>item.id===1)
  if(job.status!=='completed'||vehicle.status!=='Publicado')throw new Error('A confirmação não encerrou o trabalho e o veículo.')
  console.log(JSON.stringify({ok:true,profileIsolation:true,sellerIsolation:true,jobId:publication.id,preparedVehicle:prepared.vehicle.model,finalStatus:job.status,vehicleStatus:vehicle.status},null,2))
}finally{
  server.kill()
  await new Promise(resolve=>server.once('exit',resolve))
  await rm(dataDir,{recursive:true,force:true})
}
