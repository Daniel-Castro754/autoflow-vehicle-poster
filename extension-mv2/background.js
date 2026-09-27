const API_ORIGIN='http://127.0.0.1:3333'
const API=`${API_ORIGIN}/api`
const HEARTBEAT_ALARM='autoflow-heartbeat'
let queueConsumerRunning=false

function pendingPublishes(data){
  const entries={...(data.pendingPublishes||{})}
  if(data.pendingPublish?.jobId&&!entries[data.pendingPublish.jobId])entries[data.pendingPublish.jobId]=data.pendingPublish
  return entries
}
function senderMatchesExecution(sender,job,requireDocumentId=true){
  if(sender.tab?.id!==job?.tabId||sender.frameId!==0)return false
  try{
    const url=new URL(sender.url||'')
    const expectedPath=String(job.document||'').replace(/\/+$/,'')
    return ['facebook.com','www.facebook.com'].includes(url.hostname)&&url.protocol==='https:'
      &&url.pathname.replace(/\/+$/,'')===expectedPath
      &&(!requireDocumentId||Boolean(job.documentId)&&sender.documentId===job.documentId)
  }catch{return false}
}
function removePendingPublish(jobId,callback){
  chrome.storage.local.get(['pendingPublishes','pendingPublish'],data=>{
    const entries=pendingPublishes(data)
    delete entries[jobId]
    chrome.storage.local.set({pendingPublishes:entries},()=>chrome.storage.local.remove('pendingPublish',callback))
  })
}
function ensureHeartbeatAlarm(){
  chrome.alarms.get(HEARTBEAT_ALARM,alarm=>{if(!alarm)chrome.alarms.create(HEARTBEAT_ALARM,{delayInMinutes:.5,periodInMinutes:1})})
}
function scheduleConsumer(nextAt){
  const delay=Math.max(1,Math.min(30*60,Math.ceil((Date.parse(String(nextAt))-Date.now())/1000)))
  chrome.alarms.create(HEARTBEAT_ALARM,{delayInMinutes:Math.min(1,delay/60),periodInMinutes:1})
}
async function consumeQueue(){
  if(queueConsumerRunning)return
  queueConsumerRunning=true
  try{
    const state=await chrome.storage.local.get(['autoRun','activeAccountId','token','instanceId','pendingJob','pendingPublishes','pendingPublish'])
    if(!state.autoRun||!state.activeAccountId||!state.token||state.pendingJob)return
    const response=await fetch(`${API}/extension/queue?accountId=${encodeURIComponent(state.activeAccountId)}`,{
      headers:{'Authorization':'Bearer '+state.token},
    })
    if(response.status===401){await chrome.storage.local.set({autoRun:false});return}
    if(!response.ok)throw new Error(`Falha ao consultar a fila: HTTP ${response.status}`)
    const queue=await response.json()
    if(queue.nextScheduledAt)scheduleConsumer(queue.nextScheduledAt)
    const job=queue.jobs.find(item=>item.jobStatus==='pending'&&!item.locked&&!item.publishUncertain)
    if(!job)return
    const tab=await chrome.tabs.create({url:'https://www.facebook.com/marketplace/create/vehicle',active:true})
    if(!tab.id)throw new Error('O navegador não retornou o identificador da aba do Marketplace.')
    try{
      const prepareResponse=await fetch(`${API}/extension/jobs/${job.jobId}/prepare`,{
        method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+state.token},
        body:JSON.stringify({accountId:state.activeAccountId,instanceId:state.instanceId,tabId:tab.id,document:'/marketplace/create/vehicle'}),
      })
      const prepared=await prepareResponse.json()
      if(!prepareResponse.ok){
        if(prepareResponse.status===409&&prepared.capacity?.retryAfterSeconds){
          chrome.alarms.create(HEARTBEAT_ALARM,{delayInMinutes:Math.max(1,Math.ceil(prepared.capacity.retryAfterSeconds/60)),periodInMinutes:1})
        }
        throw new Error(prepared.error||`Falha ao reservar trabalho #${job.jobId}.`)
      }
      await chrome.storage.local.set({pendingJob:prepared})
      const sendTask=()=>chrome.tabs.sendMessage(tab.id,{type:'FILL_VEHICLE',task:prepared},()=>{if(chrome.runtime.lastError)console.warn('AutoFlow: a aba ainda não aceitou o trabalho',chrome.runtime.lastError.message)})
      chrome.tabs.get(tab.id,currentTab=>{
        if(currentTab?.status==='complete'){sendTask();return}
        const waitForDocument=(tabId,changeInfo)=>{
          if(tabId!==tab.id||changeInfo.status!=='complete')return
          chrome.tabs.onUpdated.removeListener(waitForDocument)
          sendTask()
        }
        chrome.tabs.onUpdated.addListener(waitForDocument)
      })
    }catch(error){
      await chrome.tabs.remove(tab.id).catch(()=>{})
      throw error
    }
  }catch(error){console.warn('AutoFlow: consumidor da fila pausado até a próxima verificação',error instanceof Error?error.message:String(error))}
  finally{queueConsumerRunning=false}
}
function validatePendingTab(){
  chrome.storage.local.get(['pendingJob','token'],data=>{
    const job=data.pendingJob
    if(!job?.jobId||!job?.leaseToken||!data.token)return
    chrome.tabs.get(job.tabId,tab=>{
      if(chrome.runtime.lastError||!tab||tab.discarded||!/^https:\/\/(?:www\.)?facebook\.com\/marketplace\/(?:create\/vehicle|item\/)/.test(String(tab.url||''))){
        chrome.storage.local.remove('pendingJob')
      }
    })
  })
}
chrome.runtime.onInstalled.addListener(()=>{console.info('AutoFlow instalado no Brave');ensureHeartbeatAlarm()})
chrome.runtime.onStartup.addListener(ensureHeartbeatAlarm)
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===HEARTBEAT_ALARM)validatePendingTab()})
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===HEARTBEAT_ALARM)void consumeQueue()})
ensureHeartbeatAlarm()

chrome.tabs.onUpdated.addListener((tabId,changeInfo)=>{
  if(!changeInfo.url||!/^https:\/\/(?:www\.)?facebook\.com\/marketplace\/item\//.test(changeInfo.url))return
  chrome.storage.local.get(['pendingPublishes','pendingPublish','token'],data=>{
    const matches=Object.values(pendingPublishes(data)).filter(pending=>pending.tabId===tabId)
    for(const pending of matches)reconcilePublishedTab(changeInfo.url,pending,data.token)
  })
})
function reconcilePublishedTab(resultUrl,pending,token){
    if(!pending||!token)return
    fetch(`${API}/extension/jobs/${pending.jobId}/fill-result`,{
      method:'PATCH',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({...pending.report,leaseToken:pending.leaseToken,tabId:pending.tabId,document:pending.document,documentId:pending.documentId,published:true,publishAttempted:true,resultUrl,extensionVersion:chrome.runtime.getManifest().version})
    }).then(response=>{if(response.ok){removePendingPublish(pending.jobId);chrome.storage.local.get('pendingJob',({pendingJob})=>{if(pendingJob?.jobId===pending.jobId)chrome.storage.local.remove('pendingJob')})}}).catch(()=>{})
}

chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
  if(message.type==='AUTOFLOW_RUN_QUEUE'){
    void consumeQueue().then(()=>sendResponse({ok:true}))
    return true
  }
  if(message.type==='AUTOFLOW_EXECUTION_STARTED'){
    const documentId=String(_sender.documentId||'')
    if(!/^[a-zA-Z0-9_-]{8,200}$/.test(documentId)){sendResponse({ok:false,error:'Este navegador não forneceu a identidade do documento.'});return}
    chrome.storage.local.get(['pendingJob','token'],data=>{
      const job=data.pendingJob
      if(!job||job.jobId!==message.jobId||!senderMatchesExecution(_sender,job,false)||message.document!==job.document||!data.token){
        sendResponse({ok:false,error:'A execução não corresponde a esta aba.'});return
      }
      fetch(`${API}/extension/jobs/${job.jobId}/bind-document`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+data.token},
        body:JSON.stringify({leaseToken:job.leaseToken,tabId:job.tabId,document:job.document,documentId})})
        .then(async response=>{
          const result=await response.json()
          if(!response.ok)throw new Error(result.error||'Não foi possível vincular o documento.')
          const boundJob={...job,documentId}
          chrome.storage.local.set({pendingJob:boundJob},()=>sendResponse({ok:true,documentId}))
        }).catch(error=>sendResponse({ok:false,error:error.message||String(error)}))
    })
    return true
  }
  if(message.type==='AUTOFLOW_EXECUTION_ACTIVITY'){
    chrome.storage.local.get(['pendingJob','token'],({pendingJob,token})=>{
      if(!token||!pendingJob?.leaseToken||pendingJob.jobId!==message.jobId
        ||message.document!==pendingJob.document||message.documentId!==pendingJob.documentId
        ||!senderMatchesExecution(_sender,pendingJob)){
        sendResponse({ok:false,error:'A atividade não corresponde ao documento em execução.'});return
      }
      fetch(`${API}/extension/jobs/${pendingJob.jobId}/heartbeat`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
        body:JSON.stringify({leaseToken:pendingJob.leaseToken,tabId:pendingJob.tabId,document:pendingJob.document,documentId:pendingJob.documentId})})
        .then(async response=>{
          const result=await response.json()
          if(!response.ok){if(response.status===409)chrome.storage.local.remove('pendingJob');sendResponse({ok:false,error:result.error||'O bloqueio desta execução expirou.'});return}
          sendResponse({ok:true})
        }).catch(error=>sendResponse({ok:false,error:error.message||String(error)}))
    })
    return true
  }
  if(message.type==='AUTOFLOW_PUBLISH_ABORTED'){
    chrome.storage.local.get(['pendingJob','pendingPublishes','pendingPublish','token'],data=>{
      const job=data.pendingJob
      if(!job||job.jobId!==message.jobId||!senderMatchesExecution(_sender,job)||message.document!==job.document||message.documentId!==job.documentId||!data.token){
        sendResponse({ok:false,error:'A execução não pode ser conciliada nesta aba.'});return
      }
      fetch(`${API}/extension/jobs/${job.jobId}/publish-not-clicked`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+data.token},
        body:JSON.stringify({leaseToken:job.leaseToken,tabId:job.tabId,document:job.document,documentId:job.documentId})})
        .then(async response=>{
          const result=await response.json()
          if(!response.ok)throw new Error(result.error||'Não foi possível registrar que o botão não foi clicado.')
          removePendingPublish(job.jobId,()=>sendResponse({ok:true}))
        }).catch(error=>sendResponse({ok:false,error:error.message||String(error)}))
    })
    return true
  }
  if(message.type==='AUTOFLOW_PUBLISH_CHECK'){
    chrome.storage.local.get(['pendingJob','token'],({pendingJob,token})=>{
      if(!senderMatchesExecution(_sender,pendingJob)){sendResponse({ok:false,error:'A mensagem veio de outra aba ou documento.'});return}
      if(!token||pendingJob?.jobId!==message.jobId||!pendingJob?.leaseToken){sendResponse({ok:false,error:'A execução não está mais ativa.'});return}
      fetch(`${API}/extension/jobs/${pendingJob.jobId}/publish-check`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({leaseToken:pendingJob.leaseToken,tabId:pendingJob.tabId,document:pendingJob.document,documentId:pendingJob.documentId})})
        .then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error||'A publicação não foi autorizada.');sendResponse({ok:true})})
        .catch(error=>sendResponse({ok:false,error:error.message}))
    })
    return true
  }
  if(message.type==='AUTOFLOW_PUBLISH_STARTED'){
    const tabId=_sender.tab?.id
    if(!tabId){sendResponse({ok:false,error:'A guia do Facebook não foi identificada.'});return}
    chrome.storage.local.get(['pendingJob','token'],({pendingJob,token})=>{
      if(!senderMatchesExecution(_sender,pendingJob)||message.document!==pendingJob?.document||message.documentId!==pendingJob?.documentId){sendResponse({ok:false,error:'A publicação foi iniciada em outra aba ou documento.'});return}
      const leaseToken=pendingJob?.jobId===message.jobId?pendingJob.leaseToken:''
      chrome.storage.local.get(['pendingPublishes','pendingPublish'],stored=>{
        const entries=pendingPublishes(stored)
        entries[message.jobId]={tabId,jobId:message.jobId,leaseToken,document:pendingJob.document,documentId:pendingJob.documentId,report:message.report}
        chrome.storage.local.set({pendingPublishes:entries},()=>chrome.storage.local.remove('pendingPublish',()=>{
        if(!token||!leaseToken){sendResponse({ok:false,error:'A execução não está mais ativa.'});return}
        fetch(`${API}/extension/jobs/${message.jobId}/publish-started`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({leaseToken,tabId,document:pendingJob.document,documentId:pendingJob.documentId,report:message.report})})
          .then(async response=>{
            const result=await response.json()
            if(!response.ok){removePendingPublish(message.jobId);sendResponse({ok:false,error:result.error||'A publicação não foi autorizada.'});return}
            sendResponse({ok:true})
          })
          .catch(()=>sendResponse({ok:false}))
        }))
      })
    })
    return true
  }
  if(message.type==='AUTOFLOW_FETCH_IMAGE'){
    let imageUrl
    try{
      imageUrl=new URL(String(message.url||''))
      if(imageUrl.origin!==API_ORIGIN||!/^\/uploads\/[a-f0-9]{24}\.(?:jpg|jpeg|png|webp)$/.test(imageUrl.pathname))throw new Error('Endereço de imagem inválido.')
    }catch(error){sendResponse({ok:false,error:error.message||String(error)});return}
    fetch(imageUrl.href)
      .then(async response=>{
        if(!response.ok)throw new Error(`HTTP ${response.status}`)
        const bytes=new Uint8Array(await response.arrayBuffer())
        let binary=''
        for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode.apply(null,bytes.subarray(offset,offset+32768))
        sendResponse({ok:true,dataBase64:btoa(binary),mimeType:response.headers.get('content-type')||'image/jpeg'})
      })
      .catch(error=>sendResponse({ok:false,error:error.message||String(error)}))
    return true
  }
  if(message.type!=='AUTOFLOW_FILL_RESULT'&&message.type!=='AUTOFLOW_FILL_ERROR')return
  chrome.storage.local.get(['token','pendingJob'],({token,pendingJob})=>{
    if(!token){sendResponse({ok:false,error:'Sessão da extensão expirada.'});return}
    if(!pendingJob||pendingJob.jobId!==message.jobId||!pendingJob.leaseToken){sendResponse({ok:false,error:'O bloqueio exclusivo deste trabalho não foi encontrado.'});return}
    if(!senderMatchesExecution(_sender,pendingJob)||message.document!==pendingJob.document){sendResponse({ok:false,error:'O resultado veio de outra aba ou documento.'});return}
    const report=message.type==='AUTOFLOW_FILL_ERROR'
      ?{error:String(message.error||'Falha no preenchimento'),failureCode:String(message.failureCode||'')}
      :message.report
    fetch(`${API}/extension/jobs/${message.jobId}/fill-result`,{
      method:'PATCH',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({...report,leaseToken:pendingJob.leaseToken,tabId:pendingJob.tabId,document:pendingJob.document,documentId:pendingJob.documentId,extensionVersion:chrome.runtime.getManifest().version})
    }).then(async response=>{const data=await response.json();if(!response.ok){if(response.status===409)chrome.storage.local.remove('pendingJob');throw new Error(data.error||'Falha ao atualizar o trabalho')}chrome.storage.local.remove('pendingJob',()=>{if(message.report?.published)removePendingPublish(message.jobId);sendResponse({ok:true,data});void consumeQueue()})})
      .catch(error=>sendResponse({ok:false,error:error.message}))
  })
  return true
})
