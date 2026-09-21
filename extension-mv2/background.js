const API_ORIGIN='http://127.0.0.1:3333'
const API=`${API_ORIGIN}/api`
const HEARTBEAT_ALARM='autoflow-heartbeat'

function ensureHeartbeatAlarm(){
  chrome.alarms.get(HEARTBEAT_ALARM,alarm=>{if(!alarm)chrome.alarms.create(HEARTBEAT_ALARM,{delayInMinutes:.5,periodInMinutes:1})})
}

// Backoff para o reenvio de um resultado pendente: evita bater no servidor a cada
// batimento (~60s) indefinidamente se ele estiver fora do ar por muito tempo.
function pendingResultRetryDelayMs(attempts){return Math.min(30000*Math.pow(2,Math.max(0,attempts)),300000)}

// Backoff curto para chamadas em primeiro plano, dentro do fluxo síncrono de
// preenchimento (diferente do reenvio durável acima, que pode esperar minutos).
function quickRetryDelayMs(attempt){return Math.min(500*Math.pow(2,attempt),4000)}

// Repete apenas falhas de transporte (rede fora do ar, DNS, timeout via AbortController).
// Uma resposta HTTP que chegou — mesmo 4xx/409 — nunca é repetida: é devolvida normalmente
// para quem chamou decidir, já que ela representa uma rejeição legítima do servidor.
async function fetchWithRetry(url,options,{attempts=3,timeoutMs=8000}={}){
  let lastError
  for(let attempt=0;attempt<attempts;attempt++){
    if(attempt>0)await new Promise(resolve=>setTimeout(resolve,quickRetryDelayMs(attempt-1)))
    const controller=new AbortController()
    const timer=setTimeout(()=>controller.abort(),timeoutMs)
    try{return await fetch(url,{...options,signal:controller.signal})}
    catch(error){lastError=error}
    finally{clearTimeout(timer)}
  }
  throw lastError
}

function sendFillResult(jobId,token,payload){
  return fetch(`${API}/extension/jobs/${jobId}/fill-result`,{
    method:'PATCH',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(payload)
  }).then(async response=>{
    const data=await response.json().catch(()=>({}))
    if(!response.ok){const error=new Error(data.error||'Falha ao atualizar o trabalho');error.status=response.status;throw error}
    return data
  })
}

// Reenvia um resultado que não teve a entrega confirmada anteriormente (aba fechada,
// falha de rede). Roda a cada batimento, independente de a aba original ainda existir.
function flushPendingResult(){
  chrome.storage.local.get(['pendingResult','token'],({pendingResult,token})=>{
    if(!pendingResult?.jobId||!pendingResult?.leaseToken||!token)return
    const lastAttemptAt=pendingResult.lastAttemptAt||pendingResult.queuedAt||0
    if(Date.now()-lastAttemptAt<pendingResultRetryDelayMs(pendingResult.attempts||0))return
    chrome.storage.local.set({pendingResult:{...pendingResult,attempts:(pendingResult.attempts||0)+1,lastAttemptAt:Date.now()}})
    sendFillResult(pendingResult.jobId,token,pendingResult.payload)
      .then(()=>chrome.storage.local.remove(['pendingResult','pendingJob','pendingPublish']))
      .catch(error=>{
        // Uma execução legitimamente diferente já assumiu o bloqueio: reenviar não ajuda mais.
        if(error.status===409)chrome.storage.local.remove(['pendingResult','pendingJob','pendingPublish'])
      })
  })
}

function heartbeat(){
  chrome.storage.local.get(['pendingJob','token'],data=>{
    const job=data.pendingJob
    if(!job?.jobId||!job?.leaseToken||!data.token)return
    fetch(`${API}/extension/jobs/${job.jobId}/heartbeat`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+data.token},body:JSON.stringify({leaseToken:job.leaseToken})})
      .then(response=>{if(response.status===409)chrome.storage.local.remove(['pendingJob','pendingPublish'])}).catch(()=>{})
  })
  flushPendingResult()
}
chrome.runtime.onInstalled.addListener(()=>{console.info('AutoFlow instalado no Brave');ensureHeartbeatAlarm()})
chrome.runtime.onStartup.addListener(ensureHeartbeatAlarm)
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===HEARTBEAT_ALARM)heartbeat()})
ensureHeartbeatAlarm()

chrome.tabs.onUpdated.addListener((tabId,changeInfo)=>{
  if(!changeInfo.url||!/^https:\/\/(?:www\.)?facebook\.com\/marketplace\/item\//.test(changeInfo.url))return
  chrome.storage.local.get(['pendingPublish','token'],data=>{
    const pending=data.pendingPublish
    if(!pending||pending.tabId!==tabId||!data.token)return
    const payload={...pending.report,leaseToken:pending.leaseToken,published:true,resultUrl:changeInfo.url,extensionVersion:chrome.runtime.getManifest().version}
    // Mesma persistência durável do listener de mensagens: se a aba fechar logo em
    // seguida à navegação, o batimento ainda consegue confirmar a publicação depois.
    chrome.storage.local.set({pendingResult:{jobId:pending.jobId,leaseToken:pending.leaseToken,payload,queuedAt:Date.now(),attempts:0}},()=>{
      sendFillResult(pending.jobId,data.token,payload)
        .then(()=>chrome.storage.local.remove(['pendingResult','pendingPublish','pendingJob']))
        .catch(error=>{if(error.status===409)chrome.storage.local.remove(['pendingResult','pendingPublish','pendingJob'])})
    })
  })
})

chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
  if(message.type==='AUTOFLOW_PUBLISH_ABORTED'){
    chrome.storage.local.get('pendingPublish',({pendingPublish})=>{
      if(!pendingPublish||pendingPublish.jobId===message.jobId)chrome.storage.local.remove('pendingPublish',()=>sendResponse({ok:true}))
      else sendResponse({ok:true})
    })
    return true
  }
  if(message.type==='AUTOFLOW_PUBLISH_CHECK'){
    chrome.storage.local.get(['pendingJob','token'],({pendingJob,token})=>{
      if(!token||pendingJob?.jobId!==message.jobId||!pendingJob?.leaseToken){sendResponse({ok:false,error:'A execução não está mais ativa.'});return}
      fetchWithRetry(`${API}/extension/jobs/${pendingJob.jobId}/publish-check`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({leaseToken:pendingJob.leaseToken})},{attempts:3,timeoutMs:8000})
        .then(async response=>{const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'A publicação não foi autorizada.');sendResponse({ok:true})})
        .catch(error=>sendResponse({ok:false,error:error.name==='AbortError'?'Tempo esgotado ao confirmar a publicação com o servidor.':error.message}))
    })
    return true
  }
  if(message.type==='AUTOFLOW_PUBLISH_STARTED'){
    const tabId=_sender.tab?.id
    if(!tabId){sendResponse({ok:false,error:'A guia do Facebook não foi identificada.'});return}
    chrome.storage.local.get('pendingJob',({pendingJob})=>chrome.storage.local.set({pendingPublish:{tabId,jobId:message.jobId,leaseToken:pendingJob?.jobId===message.jobId?pendingJob.leaseToken:'',report:message.report}},()=>sendResponse({ok:true})))
    return true
  }
  if(message.type==='AUTOFLOW_FETCH_IMAGE'){
    let imageUrl
    try{
      imageUrl=new URL(String(message.url||''))
      if(imageUrl.origin!==API_ORIGIN||!/^\/uploads\/[a-f0-9]{24}\.(?:jpg|jpeg|png|webp)$/.test(imageUrl.pathname))throw new Error('Endereço de imagem inválido.')
    }catch(error){sendResponse({ok:false,error:error.message||String(error)});return}
    fetchWithRetry(imageUrl.href,{},{attempts:3,timeoutMs:15000})
      .then(async response=>{
        if(!response.ok)throw new Error(`HTTP ${response.status}`)
        const bytes=new Uint8Array(await response.arrayBuffer())
        let binary=''
        for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode.apply(null,bytes.subarray(offset,offset+32768))
        sendResponse({ok:true,dataBase64:btoa(binary),mimeType:response.headers.get('content-type')||'image/jpeg'})
      })
      .catch(error=>sendResponse({ok:false,error:error.name==='AbortError'?'Tempo esgotado ao baixar a foto.':(error.message||String(error))}))
    return true
  }
  if(message.type!=='AUTOFLOW_FILL_RESULT'&&message.type!=='AUTOFLOW_FILL_ERROR')return
  chrome.storage.local.get(['token','pendingJob'],({token,pendingJob})=>{
    if(!token){sendResponse({ok:false,error:'Sessão da extensão expirada.'});return}
    if(!pendingJob||pendingJob.jobId!==message.jobId||!pendingJob.leaseToken){sendResponse({ok:false,error:'O bloqueio exclusivo deste trabalho não foi encontrado.'});return}
    const report=message.type==='AUTOFLOW_FILL_ERROR'
      ?{error:String(message.error||'Falha no preenchimento')}
      :message.report
    const payload={...report,leaseToken:pendingJob.leaseToken,extensionVersion:chrome.runtime.getManifest().version}
    // Persistimos antes de tentar: se a entrega falhar (rede, aba fechada logo em seguida),
    // o batimento reenvia sozinho até confirmar, sem depender desta aba continuar aberta.
    chrome.storage.local.set({pendingResult:{jobId:message.jobId,leaseToken:pendingJob.leaseToken,payload,queuedAt:Date.now(),attempts:0}},()=>{
      sendFillResult(message.jobId,token,payload)
        .then(data=>{
          chrome.storage.local.remove('pendingResult')
          chrome.storage.local.remove('pendingJob')
          if(message.report?.published)chrome.storage.local.remove('pendingPublish')
          sendResponse({ok:true,data})
        })
        .catch(error=>{
          if(error.status===409){chrome.storage.local.remove(['pendingResult','pendingJob','pendingPublish']);sendResponse({ok:false,error:error.message});return}
          sendResponse({ok:false,error:error.message,willRetry:true})
        })
    })
  })
  return true
})
