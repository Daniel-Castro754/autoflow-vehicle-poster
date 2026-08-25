const API_ORIGIN='http://127.0.0.1:3333'
const API=`${API_ORIGIN}/api`
chrome.runtime.onInstalled.addListener(()=>console.info('AutoFlow instalado no Brave'))

setInterval(()=>chrome.storage.local.get(['pendingJob','token'],data=>{
  const job=data.pendingJob
  if(!job?.jobId||!job?.leaseToken||!data.token)return
  fetch(`${API}/extension/jobs/${job.jobId}/heartbeat`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+data.token},body:JSON.stringify({leaseToken:job.leaseToken})})
    .then(response=>{if(response.status===409)chrome.storage.local.remove(['pendingJob','pendingPublish'])}).catch(()=>{})
}),45000)

chrome.tabs.onUpdated.addListener((tabId,changeInfo)=>{
  if(!changeInfo.url||!/^https:\/\/(?:www\.)?facebook\.com\/marketplace\/item\//.test(changeInfo.url))return
  chrome.storage.local.get(['pendingPublish','token'],data=>{
    const pending=data.pendingPublish
    if(!pending||pending.tabId!==tabId||!data.token)return
    fetch(`${API}/extension/jobs/${pending.jobId}/fill-result`,{
      method:'PATCH',headers:{'Content-Type':'application/json','Authorization':'Bearer '+data.token},
      body:JSON.stringify({...pending.report,leaseToken:pending.leaseToken,published:true,resultUrl:changeInfo.url,extensionVersion:chrome.runtime.getManifest().version})
    }).then(response=>{if(response.ok||response.status===409)chrome.storage.local.remove(['pendingPublish','pendingJob'])}).catch(()=>{})
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
    const report=message.type==='AUTOFLOW_FILL_ERROR'
      ?{error:String(message.error||'Falha no preenchimento')}
      :message.report
    fetch(`${API}/extension/jobs/${message.jobId}/fill-result`,{
      method:'PATCH',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({...report,leaseToken:pendingJob.leaseToken,extensionVersion:chrome.runtime.getManifest().version})
    }).then(async response=>{const data=await response.json();if(!response.ok){if(response.status===409)chrome.storage.local.remove(['pendingJob','pendingPublish']);throw new Error(data.error||'Falha ao atualizar o trabalho')}chrome.storage.local.remove('pendingJob');if(message.report?.published)chrome.storage.local.remove('pendingPublish');sendResponse({ok:true,data})})
      .catch(error=>sendResponse({ok:false,error:error.message}))
  })
  return true
})
