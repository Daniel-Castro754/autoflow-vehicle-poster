import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runHealthCheck } from '../server/services/health-monitor.ts'

const port=3455
const base=`http://127.0.0.1:${port}/api`
const dataDir=await mkdtemp(join(tmpdir(),'autoflow-safety-test-'))
const adminEmail='admin-safety@autoflow.local'
const adminPassword='admin-safety-password-strong'
const jpegBase64=value=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.from(value)]).toString('base64')
const server=spawn(process.execPath,['server/server.ts'],{cwd:process.cwd(),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dataDir,AUTH_SECRET:'publish-safety-test-secret-with-32-chars',INITIAL_ADMIN_NAME:'Administrador Teste',INITIAL_ADMIN_EMAIL:adminEmail,INITIAL_ADMIN_PASSWORD:adminPassword},stdio:['ignore','pipe','pipe']})
let serverOutput=''
server.stdout.on('data',chunk=>serverOutput+=chunk)
server.stderr.on('data',chunk=>serverOutput+=chunk)

async function waitForServer(){for(let attempt=0;attempt<40;attempt++){try{const response=await fetch(base+'/health');if(response.ok)return}catch{/* API ainda inicializando */}await new Promise(resolve=>setTimeout(resolve,100))}throw new Error(`A API de teste não iniciou. ${serverOutput}`)}
async function login(email,password){const response=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});const data=await response.json();if(!response.ok)throw new Error(data.error);return data.token}
async function call(path,token,options={}){const response=await fetch(base+path,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}});const data=await response.json();if(!response.ok)throw Object.assign(new Error(`${response.status} ${path}: ${data.error}`),{status:response.status,body:data});return data}
async function expectStatus(status,operation){try{await operation();throw new Error(`A operação deveria responder ${status}.`)}catch(error){if(error.status!==status)throw error}}

async function createReadyVehicle(token,overrides={}){
  const vehicle=await call('/vehicles',token,{method:'POST',body:JSON.stringify({year:2023,make:'Toyota',model:'Corolla',trim:'XEi',price:119900,km:42000,vehicleType:'Carro/picape',location:'São Paulo, SP',transmission:'Automático',fuelType:'Flex',bodyType:'Sedã',condition:'Excelente',exteriorColor:'Prateado',interiorColor:'Preto',description:'Veículo para teste de segurança de publicação.',status:'Pronto',...overrides})})
  await call(`/vehicles/${vehicle.id}/images`,token,{method:'POST',body:JSON.stringify({name:'foto.jpg',mimeType:'image/jpeg',dataBase64:jpegBase64(`foto-${vehicle.id}`)})})
  return vehicle
}

try{
  await waitForServer()
  const adminToken=await login(adminEmail,adminPassword)
  await call('/settings',adminToken,{method:'PATCH',body:JSON.stringify({organizationName:'Safety Test',dailyLimit:10,stuckTimeoutMinutes:1,maxRetries:3,descriptionTemplate:'',autoAdvance:true,fillGroups:false,autoPublish:false})})
  const account=await call('/social-accounts',adminToken,{method:'POST',body:JSON.stringify({userId:(await call('/team',adminToken)).users[0].id,label:'Facebook Teste',browserProfile:'Brave Perfil Teste'})})
  const testDb=new DatabaseSync(join(dataDir,'autoflow.db'))
  const jobRow=id=>testDb.prepare('SELECT status,paused,fill_report fillReport,attempt_count attemptCount,publish_attempt_at publishAttemptAt,last_lease_token lastLeaseToken FROM publication_jobs WHERE id=?').get(id)
  const backdateStuck=id=>{
    testDb.prepare("UPDATE publication_jobs SET started_at=datetime('now','-5 minutes') WHERE id=?").run(id)
    testDb.prepare("UPDATE publication_jobs SET lease_expires_at=datetime('now','-1 second') WHERE id=?").run(id)
  }

  // 1. Reenvio de fill-result com o mesmo leaseToken depois de já processado deve ser idempotente.
  const vehicleA=await createReadyVehicle(adminToken)
  const publicationA=await call('/publications',adminToken,{method:'POST',body:JSON.stringify({vehicleId:vehicleA.id,accountId:account.id})})
  const preparedA=await call(`/extension/jobs/${publicationA.id}/prepare`,adminToken,{method:'POST',body:JSON.stringify({accountId:account.id,instanceId:'safety_instance_alpha'})})
  const firstResult=await call(`/extension/jobs/${publicationA.id}/fill-result`,adminToken,{method:'PATCH',body:JSON.stringify({leaseToken:preparedA.leaseToken,filledCount:14,totalCount:14,imageCount:1,missing:[],fields:[],advanced:true,selectedGroups:[],missingGroups:[],flowIssues:[],published:true,publishAttempted:true,resultUrl:'https://www.facebook.com/marketplace/item/1',extensionVersion:'0.13.0'})})
  if(firstResult.status!=='completed')throw new Error('O primeiro envio de resultado deveria concluir o trabalho.')
  const resend=await call(`/extension/jobs/${publicationA.id}/fill-result`,adminToken,{method:'PATCH',body:JSON.stringify({leaseToken:preparedA.leaseToken,filledCount:14,totalCount:14,imageCount:1,missing:[],fields:[],advanced:true,selectedGroups:[],missingGroups:[],flowIssues:[],published:true,publishAttempted:true,resultUrl:'https://www.facebook.com/marketplace/item/1',extensionVersion:'0.13.0'})})
  if(resend.status!=='completed'||resend.idempotent!==true)throw new Error('O reenvio do mesmo resultado deveria ser idempotente.')
  if(jobRow(publicationA.id).status!=='completed')throw new Error('O reenvio idempotente não deveria alterar o estado do trabalho.')
  await expectStatus(409,()=>call(`/extension/jobs/${publicationA.id}/fill-result`,adminToken,{method:'PATCH',body:JSON.stringify({leaseToken:'token-diferente-de-qualquer-ciclo',error:'Não deveria ser aceito'})}))

  // 2. Um job travado cujo checkpoint de publish-check foi registrado não pode voltar
  //    direto para "pending" automaticamente: o clique em Publicar pode já ter ocorrido.
  const vehicleB=await createReadyVehicle(adminToken)
  const publicationB=await call('/publications',adminToken,{method:'POST',body:JSON.stringify({vehicleId:vehicleB.id,accountId:account.id})})
  const preparedB=await call(`/extension/jobs/${publicationB.id}/prepare`,adminToken,{method:'POST',body:JSON.stringify({accountId:account.id,instanceId:'safety_instance_beta'})})
  await call(`/extension/jobs/${publicationB.id}/publish-check`,adminToken,{method:'POST',body:JSON.stringify({leaseToken:preparedB.leaseToken})})
  if(!jobRow(publicationB.id).publishAttemptAt)throw new Error('O checkpoint de publish-check não foi persistido.')
  backdateStuck(publicationB.id)
  await runHealthCheck(testDb,{autoRecover:true})
  const recoveredB=jobRow(publicationB.id)
  if(recoveredB.status!=='awaiting_confirmation'||!recoveredB.paused)throw new Error('Um job com publicação possivelmente em andamento voltou direto para a fila.')
  if(!JSON.parse(recoveredB.fillReport||'{}').publishAttempted)throw new Error('O relatório do job ambíguo não sinalizou a tentativa de publicação.')
  await expectStatus(409,()=>call(`/publications/${publicationB.id}`,adminToken,{method:'PATCH',body:JSON.stringify({status:'pending'})}))
  await call(`/publications/${publicationB.id}`,adminToken,{method:'PATCH',body:JSON.stringify({status:'pending',confirmNoPublication:true})})
  if(jobRow(publicationB.id).status!=='pending')throw new Error('A confirmação manual deveria liberar o trabalho para a fila.')

  // 3. Sem sinal de publish-check, a recuperação automática continua segura (volta para
  //    "pending"), mas passa a respeitar max_retries em vez de poder repetir para sempre.
  const vehicleC=await createReadyVehicle(adminToken)
  const publicationC=await call('/publications',adminToken,{method:'POST',body:JSON.stringify({vehicleId:vehicleC.id,accountId:account.id})})
  await call(`/extension/jobs/${publicationC.id}/prepare`,adminToken,{method:'POST',body:JSON.stringify({accountId:account.id,instanceId:'safety_instance_gamma'})})
  backdateStuck(publicationC.id)
  await runHealthCheck(testDb,{autoRecover:true})
  const recoveredC=jobRow(publicationC.id)
  if(recoveredC.status!=='pending'||recoveredC.publishAttemptAt)throw new Error('Um job sem sinal de publicação deveria voltar normalmente para a fila.')

  testDb.prepare('UPDATE publication_jobs SET attempt_count=? WHERE id=?').run(recoveredC.attemptCount+2,publicationC.id)
  await call(`/extension/jobs/${publicationC.id}/prepare`,adminToken,{method:'POST',body:JSON.stringify({accountId:account.id,instanceId:'safety_instance_gamma'})})
  backdateStuck(publicationC.id)
  await runHealthCheck(testDb,{autoRecover:true})
  const exhaustedC=jobRow(publicationC.id)
  if(exhaustedC.status!=='error')throw new Error('Um job que esgotou as tentativas de recuperação deveria virar erro em vez de repetir para sempre.')

  // 4. Um relatório de preenchimento parcial que sinaliza suspeita de mudança de layout do
  //    Facebook deve persistir esse sinal no fill_report (o disparo do alerta em si não é
  //    verificável sem Telegram/webhook configurado, mas degrada graciosamente sem erro).
  const vehicleD=await createReadyVehicle(adminToken)
  const publicationD=await call('/publications',adminToken,{method:'POST',body:JSON.stringify({vehicleId:vehicleD.id,accountId:account.id})})
  const preparedD=await call(`/extension/jobs/${publicationD.id}/prepare`,adminToken,{method:'POST',body:JSON.stringify({accountId:account.id,instanceId:'safety_instance_delta'})})
  const driftResult=await call(`/extension/jobs/${publicationD.id}/fill-result`,adminToken,{method:'PATCH',body:JSON.stringify({leaseToken:preparedD.leaseToken,filledCount:12,totalCount:14,imageCount:1,missing:['Ano','Fabricante'],fields:[],advanced:false,selectedGroups:[],missingGroups:[],flowIssues:['O Facebook não liberou a segunda etapa após as tentativas de preenchimento e correção.'],published:false,publishAttempted:false,layoutDriftSuspected:true,notFoundFields:['Ano','Fabricante'],extensionVersion:'0.14.0'})})
  if(driftResult.status!=='awaiting_confirmation')throw new Error('Um preenchimento parcial sem exceção deveria aguardar confirmação normalmente.')
  const driftReport=JSON.parse(jobRow(publicationD.id).fillReport||'{}')
  if(driftReport.layoutDriftSuspected!==true)throw new Error('O sinal de suspeita de mudança de layout não foi persistido no relatório.')
  if(JSON.stringify(driftReport.notFoundFields)!==JSON.stringify(['Ano','Fabricante']))throw new Error('Os campos não localizados não foram persistidos corretamente.')

  testDb.close()
  console.log(JSON.stringify({ok:true,idempotentFillResult:true,staleRecoveryRequiresConfirmation:true,safeRecoveryRespectsMaxRetries:true,layoutDriftSignalPersisted:true},null,2))
}finally{
  if(server.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve))}
  await rm(dataDir,{recursive:true,force:true})
}
