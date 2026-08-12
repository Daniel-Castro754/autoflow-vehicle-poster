const API='http://localhost:3333/api'
chrome.runtime.onInstalled.addListener(()=>console.info('AutoFlow instalado no Brave'))

chrome.tabs.onUpdated.addListener((tabId,changeInfo)=>{
  if(!changeInfo.url||!/^https:\/\/(?:www\.)?facebook\.com\/marketplace\/item\//.test(changeInfo.url))return
  chrome.storage.local.get(['pendingPublish','token'],data=>{
    const pending=data.pendingPublish
    if(!pending||pending.tabId!==tabId||!data.token)return
    fetch(`${API}/extension/jobs/${pending.jobId}/fill-result`,{
      method:'PATCH',headers:{'Content-Type':'application/json','Authorization':'Bearer '+data.token},
      body:JSON.stringify({...pending.report,published:true,resultUrl:changeInfo.url,extensionVersion:chrome.runtime.getManifest().version})
    }).then(response=>{if(response.ok)chrome.storage.local.remove('pendingPublish')}).catch(()=>{})
  })
})

chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
  if(message.type==='AUTOFLOW_PUBLISH_STARTED'){
    const tabId=_sender.tab?.id
    if(!tabId){sendResponse({ok:false,error:'A guia do Facebook não foi identificada.'});return}
    chrome.storage.local.set({pendingPublish:{tabId,jobId:message.jobId,report:message.report}},()=>sendResponse({ok:true}))
    return true
  }
  if(message.type==='AUTOFLOW_FETCH_IMAGE'){
    let imageUrl
    try{
      imageUrl=new URL(String(message.url||''))
      if(!['http://localhost:3333','http://127.0.0.1:3333'].includes(imageUrl.origin)||!/^\/uploads\/[a-f0-9]{24}\.(?:jpg|jpeg|png|webp)$/.test(imageUrl.pathname))throw new Error('Endereço de imagem inválido.')
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
  chrome.storage.local.get('token',({token})=>{
    if(!token){sendResponse({ok:false,error:'Sessão da extensão expirada.'});return}
    const report=message.type==='AUTOFLOW_FILL_ERROR'
      ?{error:String(message.error||'Falha no preenchimento')}
      :message.report
    fetch(`${API}/extension/jobs/${message.jobId}/fill-result`,{
      method:'PATCH',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({...report,extensionVersion:chrome.runtime.getManifest().version})
    }).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error||'Falha ao atualizar o trabalho');if(message.report?.published)chrome.storage.local.remove('pendingPublish');sendResponse({ok:true,data})})
      .catch(error=>sendResponse({ok:false,error:error.message}))
  })
  return true
})
