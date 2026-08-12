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

async function waitForServer(){for(let attempt=0;attempt<40;attempt++){try{const response=await fetch(base+'/health');if(response.ok)return}catch{/* API ainda inicializando */}await new Promise(resolve=>setTimeout(resolve,100))}throw new Error(`A API de teste não iniciou. ${serverOutput}`)}
async function login(email){const response=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'demo1234'})});const data=await response.json();if(!response.ok)throw new Error(data.error);return data.token}
async function call(path,token,options={}){const response=await fetch(base+path,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}});const data=await response.json();if(!response.ok)throw Object.assign(new Error(`${response.status} ${path}: ${data.error}`),{status:response.status,body:data});return data}
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
  await call('/settings',adminToken,{method:'PATCH',body:JSON.stringify({organizationName:'AutoPrime Veículos',defaultLocation:'São Paulo, SP',dailyLimit:10,descriptionTemplate:'',autoAdvance:true,fillGroups:true,targetGroups:['Compra-se e Vende-se','Carros e Motos Criciúma e Região'],autoPublish:false})})
  await expectStatus(403,()=>call('/social-accounts',sellerToken,{method:'POST',body:JSON.stringify({userId:marina.id,label:'Não permitido',browserProfile:'Brave Perfil 3'})}))
  const sellerAccounts=await call('/extension/accounts',sellerToken)
  if(sellerAccounts.accounts.length!==1||sellerAccounts.accounts[0].id!==second.id)throw new Error('O vendedor recebeu perfis de outro usuário.')
  await expectStatus(403,()=>call(`/extension/queue?accountId=${first.id}`,sellerToken))
  await expectStatus(400,()=>call('/vehicles',adminToken,{method:'POST',body:JSON.stringify({year:2024,make:'Marca inventada',model:'Teste',price:50000,km:100,vehicleType:'Carro/picape',location:'São Paulo, SP',transmission:'Automático',fuelType:'Flex',bodyType:'Sedã',condition:'Excelente',exteriorColor:'Prateado',interiorColor:'Preto',description:'Teste de validação',status:'Rascunho'})}))

  try{
    await call('/publications',adminToken,{method:'POST',body:JSON.stringify({vehicleId:4,accountId:first.id})})
    throw new Error('A publicação deveria ter sido bloqueada por falta de fotos.')
  }catch(error){
    if(error.status!==422||!error.body?.missing?.includes('Fotos'))throw error
  }
  const blockedVehicle=(await call('/vehicles',adminToken)).vehicles.find(item=>item.id===4)
  if(blockedVehicle.status!=='Atenção')throw new Error('O veículo incompleto não foi marcado como Atenção.')

  const imageOne=await call('/vehicles/1/images',adminToken,{method:'POST',body:JSON.stringify({name:'foto-1.jpg',mimeType:'image/jpeg',dataBase64:Buffer.from('foto-um').toString('base64')})})
  const imageTwo=await call('/vehicles/1/images',adminToken,{method:'POST',body:JSON.stringify({name:'foto-2.jpg',mimeType:'image/jpeg',dataBase64:Buffer.from('foto-dois').toString('base64')})})
  const orderedBefore=(await call('/vehicles/1/images',adminToken)).images.map(item=>item.id)
  if(orderedBefore[0]!==imageOne.id||orderedBefore[1]!==imageTwo.id)throw new Error('A ordem inicial das fotos não respeitou o upload.')
  await call('/vehicles/1/images/reorder',adminToken,{method:'PATCH',body:JSON.stringify({order:[imageTwo.id,imageOne.id]})})
  const orderedAfter=(await call('/vehicles/1/images',adminToken)).images.map(item=>item.id)
  if(orderedAfter[0]!==imageTwo.id||orderedAfter[1]!==imageOne.id)throw new Error('A reordenação de fotos não foi aplicada.')
  await expectStatus(400,()=>call('/vehicles/1/images/reorder',adminToken,{method:'PATCH',body:JSON.stringify({order:[imageOne.id]})}))

  const vehicleOne=(await call('/vehicles',adminToken)).vehicles.find(item=>item.id===1)
  await call('/vehicles/1',adminToken,{method:'PATCH',body:JSON.stringify({...vehicleOne,condition:'Excelente',exteriorColor:'Prateado',interiorColor:'Preto',status:'Pronto'})})

  const publication=await call('/publications',adminToken,{method:'POST',body:JSON.stringify({vehicleId:1,accountId:first.id})})
  const firstQueue=await call(`/extension/queue?accountId=${first.id}`,adminToken)
  const secondQueue=await call(`/extension/queue?accountId=${second.id}`,adminToken)
  if(firstQueue.jobs.length!==1||firstQueue.jobs[0].jobId!==publication.id)throw new Error('O trabalho não apareceu no perfil correto.')
  if(secondQueue.jobs.length!==0)throw new Error('O trabalho vazou para outro perfil.')
  const prepared=await call(`/extension/jobs/${publication.id}/prepare`,adminToken,{method:'POST',body:JSON.stringify({accountId:first.id})})
  if(prepared.vehicle.interiorColor!=='Preto')throw new Error('A cor interna não chegou à extensão.')
  if(prepared.vehicle.condition!=='Excelente')throw new Error('A condição do veículo não chegou à extensão.')
  if(!prepared.automation.autoAdvance||!prepared.automation.fillGroups||prepared.automation.autoPublish||prepared.automation.targetGroups.length!==2)throw new Error('As regras de automação não chegaram à extensão.')
  await call(`/extension/jobs/${publication.id}/fill-result`,adminToken,{method:'PATCH',body:JSON.stringify({filledCount:14,totalCount:15,imageCount:7,missing:['Cor interna'],fields:[{name:'Cor interna',ok:false}],advanced:false,selectedGroups:[],missingGroups:[],published:false,extensionVersion:'0.8.0'})})
  let job=(await call('/publications',adminToken)).jobs.find(item=>item.id===publication.id)
  if(job.status!=='awaiting_confirmation'||job.fillReport?.missing?.[0]!=='Cor interna')throw new Error('O relatório de preenchimento não foi persistido.')
  let retainedQueue=await call(`/extension/queue?accountId=${first.id}`,adminToken)
  if(retainedQueue.jobs.length!==1||retainedQueue.jobs[0].jobStatus!=='awaiting_confirmation')throw new Error('O veículo saiu da extensão logo após o preenchimento.')
  await call('/publications/extension-visibility',adminToken,{method:'PATCH',body:JSON.stringify({ids:[publication.id],visible:false})})
  retainedQueue=await call(`/extension/queue?accountId=${first.id}`,adminToken)
  job=(await call('/publications',adminToken)).jobs.find(item=>item.id===publication.id)
  if(retainedQueue.jobs.length!==0||job.status!=='awaiting_confirmation'||job.extensionVisible!==0)throw new Error('A remoção manual da extensão alterou o histórico ou não ocultou o veículo.')
  await call('/publications/extension-visibility',adminToken,{method:'PATCH',body:JSON.stringify({ids:[publication.id],visible:true})})
  retainedQueue=await call(`/extension/queue?accountId=${first.id}`,adminToken)
  if(retainedQueue.jobs.length!==1)throw new Error('O veículo não voltou para a extensão após ser reativado no painel.')
  await call(`/publications/${publication.id}`,adminToken,{method:'PATCH',body:JSON.stringify({status:'pending'})})
  job=(await call('/publications',adminToken)).jobs.find(item=>item.id===publication.id)
  if(job.fillReport||job.errorCode)throw new Error('A repetição não limpou o diagnóstico anterior.')
  await call(`/extension/jobs/${publication.id}/prepare`,adminToken,{method:'POST',body:JSON.stringify({accountId:first.id})})
  await call(`/extension/jobs/${publication.id}/fill-result`,adminToken,{method:'PATCH',body:JSON.stringify({filledCount:15,totalCount:15,imageCount:7,missing:[],fields:[],advanced:true,selectedGroups:['Compra-se e Vende-se','Carros e Motos Criciúma e Região'],missingGroups:[],published:true,resultUrl:'https://www.facebook.com/marketplace/item/123',extensionVersion:'0.8.0'})})
  job=(await call('/publications',adminToken)).jobs.find(item=>item.id===publication.id)
  const vehicle=(await call('/vehicles',adminToken)).vehicles.find(item=>item.id===1)
  if(job.status!=='completed'||vehicle.status!=='Publicado'||!job.fillReport?.published||job.fillReport?.selectedGroups?.length!==2)throw new Error('A publicação automática não encerrou o trabalho e o veículo.')

  await call('/vehicles/1/mark-sold',adminToken,{method:'POST'})
  let soldVehicle=(await call('/vehicles',adminToken)).vehicles.find(item=>item.id===1)
  if(soldVehicle.status!=='Vendido'||!soldVehicle.soldAt||soldVehicle.pendingRemovalCount!==1)throw new Error('Marcar como vendido não registrou a data nem contou o anúncio pendente de remoção.')
  await call(`/publications/${publication.id}`,adminToken,{method:'PATCH',body:JSON.stringify({status:'removed'})})
  job=(await call('/publications',adminToken)).jobs.find(item=>item.id===publication.id)
  if(job.status!=='removed'||!job.removedAt)throw new Error('A remoção do anúncio não foi registrada.')
  soldVehicle=(await call('/vehicles',adminToken)).vehicles.find(item=>item.id===1)
  if(soldVehicle.pendingRemovalCount!==0)throw new Error('O veículo continuou marcado como pendente de remoção após confirmar a remoção do anúncio.')

  console.log(JSON.stringify({ok:true,profileIsolation:true,sellerIsolation:true,jobId:publication.id,preparedVehicle:prepared.vehicle.model,finalStatus:job.status,vehicleStatus:soldVehicle.status},null,2))
}finally{
  server.kill()
  await new Promise(resolve=>server.once('exit',resolve))
  await rm(dataDir,{recursive:true,force:true})
}
