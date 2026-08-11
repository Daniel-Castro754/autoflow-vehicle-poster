const API='http://localhost:3333/api'
chrome.runtime.onInstalled.addListener(()=>console.info('AutoFlow instalado no Brave'))

chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
  if(message.type!=='AUTOFLOW_FILL_RESULT'&&message.type!=='AUTOFLOW_FILL_ERROR')return
  chrome.storage.local.get('token',({token})=>{
    if(!token){sendResponse({ok:false,error:'Sessão da extensão expirada.'});return}
    const report=message.type==='AUTOFLOW_FILL_ERROR'
      ?{error:String(message.error||'Falha no preenchimento')}
      :message.report
    fetch(`${API}/extension/jobs/${message.jobId}/fill-result`,{
      method:'PATCH',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({...report,extensionVersion:chrome.runtime.getManifest().version})
    }).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error||'Falha ao atualizar o trabalho');sendResponse({ok:true,data})})
      .catch(error=>sendResponse({ok:false,error:error.message}))
  })
  return true
})
