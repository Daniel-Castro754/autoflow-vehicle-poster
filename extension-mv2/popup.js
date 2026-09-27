const API='http://127.0.0.1:3333/api'
const $=id=>document.getElementById(id)
let token='',activeAccountId=0,availableAccounts=[]
let instanceId=''
function request(path,options={}){return fetch(API+path,{...options,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,...options.headers}}).then(async r=>{const data=await r.json();if(!r.ok)throw new Error(data.error||'Falha na operação');return data})}
function setConnected(connected,user){$('loginView').hidden=connected;$('queueView').hidden=!connected;$('apiState').className=connected?'online':'';if(user)$('userName').textContent=user.name}
function statusLabel(status){return({pending:'Pendente',filling:'Preenchendo',error:'Revisar erro',awaiting_confirmation:'Preenchido'})[status]||status}
function loadAccounts(){
  $('queue').innerHTML='<div class="empty">Carregando perfis...</div>'
  return request('/extension/accounts').then(({accounts})=>{availableAccounts=accounts;return new Promise(resolve=>chrome.storage.local.get('activeAccountId',data=>resolve(data.activeAccountId)))}).then(saved=>{
    const selected=availableAccounts.find(account=>account.id===Number(saved))||availableAccounts[0]
    $('accountSelect').innerHTML=''
    availableAccounts.forEach(account=>{const option=document.createElement('option');option.value=String(account.id);option.textContent=`${account.label} · ${account.owner}`;$('accountSelect').appendChild(option)})
    if(!selected){activeAccountId=0;$('profileMeta').textContent='Nenhum perfil associado. Cadastre um em Equipe e contas.';$('accountSelect').disabled=true;$('autoRun').disabled=true;$('queue').innerHTML='<div class="empty">Associe um perfil do Brave antes de usar a fila.</div>';return}
    activeAccountId=selected.id;$('accountSelect').disabled=false;$('accountSelect').value=String(selected.id);$('autoRun').disabled=false;updateProfileMeta(selected);chrome.storage.local.set({activeAccountId},updateAutoRunButton);loadQueue()
  }).catch(error=>$('queue').innerHTML=`<div class="empty">${escapeHtml(error.message)}</div>`)
}
function updateProfileMeta(account){$('profileMeta').textContent=`Perfil local: ${account.browserProfile||'não informado'} · ${account.status==='connected'?'conectado':'aguardando conexão'}`}
function loadQueue(){
  if(!activeAccountId)return
  $('queue').innerHTML='<div class="empty">Carregando...</div>'
  request('/extension/queue?accountId='+encodeURIComponent(activeAccountId)).then(({jobs,account,automation})=>{
    if(account)updateProfileMeta({...account,status:'connected'})
    const steps=['Preencher dados']
    if(automation?.autoAdvance)steps.push('Avançar')
    if(automation?.fillGroups)steps.push(`${automation.targetGroups?.length||0} grupos`)
    if(automation?.autoPublish)steps.push('Publicar')
    $('automationTitle').textContent=automation?.autoPublish?'Publicação automática ativa':'Confirmação final manual'
    $('automationSummary').textContent=steps.join(' → ')+(automation?.autoPublish?'':' → revisar e publicar manualmente')
    $('queue').innerHTML=jobs.length?'':'<div class="empty">Nenhum trabalho pendente para este perfil.<br><small>No painel, use ⋯ → Adicionar à fila e escolha este perfil.</small></div>'
    jobs.forEach(job=>{const card=document.createElement('div');const locked=Boolean(job.locked||job.publishUncertain);card.className=`vehicle ${locked?'locked-job':job.jobStatus==='error'?'error-job':job.jobStatus==='filling'?'filling-job':job.jobStatus==='awaiting_confirmation'?'filled-job':''}`;const action=job.publishUncertain?'Resultado de publicação a confirmar':locked?'Em uso em outra aba':job.jobStatus==='pending'?'Abrir e preencher':job.jobStatus==='awaiting_confirmation'?'Preencher novamente':'Retomar preenchimento';card.innerHTML=`<div class="vehicle-top"><strong>${job.year} ${escapeHtml(job.make)} ${escapeHtml(job.model)}</strong><span class="status ${locked?'locked':job.jobStatus}">${job.publishUncertain?'Resultado incerto':locked?'Em execução':statusLabel(job.jobStatus)}</span></div><small>${Number(job.km).toLocaleString('pt-BR')} km · ${Number(job.price).toLocaleString('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0})} · ${Number(job.imageCount||0)} fotos</small><div class="job-meta">Trabalho #${job.jobId} · ${escapeHtml(job.accountLabel)}${job.errorCode?' · '+escapeHtml(job.errorCode):''}</div><button data-id="${job.jobId}" ${locked?'disabled title="Resolva a pendência no painel antes de repetir."':''}>${action}</button>`;if(!locked)card.querySelector('button').onclick=()=>prepare(job.jobId);$('queue').appendChild(card)})
  }).catch(error=>$('queue').innerHTML=`<div class="empty">${escapeHtml(error.message)}</div>`)
}
function prepare(jobId){
  if(!instanceId){alert('A identificação local da extensão ainda está carregando. Tente novamente.');return}
  chrome.storage.local.get(['pendingJob'],state=>{
    if(state.pendingJob?.jobId){
      chrome.tabs.get(state.pendingJob.tabId,tab=>{
        if(!chrome.runtime.lastError&&tab){
          chrome.tabs.update(tab.id,{active:true})
          alert(`O trabalho #${state.pendingJob.jobId} já está ativo nesta extensão.`)
          return
        }
        chrome.storage.local.remove('pendingJob',()=>openJob(jobId))
      })
      return
    }
    openJob(jobId)
  })
}
function openJob(jobId){chrome.tabs.create({url:'https://www.facebook.com/marketplace/create/vehicle'},tab=>{const tabId=tab.id;request('/extension/jobs/'+jobId+'/prepare',{method:'POST',body:JSON.stringify({accountId:activeAccountId,instanceId,tabId,document:'/marketplace/create/vehicle'})}).then(task=>chrome.storage.local.set({pendingJob:task},()=>chrome.tabs.sendMessage(tabId,{type:'FILL_VEHICLE',task}))).catch(error=>{chrome.tabs.remove(tabId);alert(error.message)})})}
function updateAutoRunButton(){
  chrome.storage.local.get('autoRun',({autoRun})=>{
    $('autoRun').textContent=autoRun?'Pausar consumo automático':'Iniciar consumo automático'
    $('autoRun').classList.toggle('running',Boolean(autoRun))
    $('autoRun').setAttribute('aria-pressed',String(Boolean(autoRun)))
  })
}
function escapeHtml(value){const div=document.createElement('div');div.textContent=String(value);return div.innerHTML}
$('login').onclick=()=>{$('loginError').textContent='';fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('email').value,password:$('password').value})}).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error);token=data.token;chrome.storage.local.set({token,user:data.user});setConnected(true,data.user);loadAccounts()}).catch(error=>$('loginError').textContent=error.message)}
$('logout').onclick=async()=>{
  const activeToken=token
  try{
    const response=await fetch(API+'/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+activeToken}})
    if(!response.ok)console.warn('AutoFlow: a sessão do servidor não foi revogada',response.status)
  }catch(error){console.warn('AutoFlow: não foi possível revogar a sessão no servidor',error instanceof Error?error.message:String(error))}
  chrome.storage.local.remove(['token','user','activeAccountId','pendingJob','autoRun'],()=>{token='';activeAccountId=0;setConnected(false);updateAutoRunButton()})
}
$('refresh').onclick=loadQueue
$('autoRun').onclick=()=>chrome.storage.local.get('autoRun',({autoRun})=>{
  const next=!autoRun
  chrome.storage.local.set({autoRun:next},()=>{
    updateAutoRunButton()
    if(next)chrome.runtime.sendMessage({type:'AUTOFLOW_RUN_QUEUE'})
  })
})
$('accountSelect').onchange=()=>{activeAccountId=Number($('accountSelect').value);const account=availableAccounts.find(item=>item.id===activeAccountId);if(account)updateProfileMeta(account);chrome.storage.local.set({activeAccountId,autoRun:false},()=>{updateAutoRunButton();loadQueue()})}
chrome.storage.local.get(['token','user','instanceId'],data=>{instanceId=data.instanceId||`${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;if(!data.instanceId)chrome.storage.local.set({instanceId});token=data.token||'';if(token){request('/me').then(({user})=>{setConnected(true,user);loadAccounts()}).catch(()=>chrome.storage.local.remove(['token','user','activeAccountId','pendingJob'],()=>setConnected(false)))}else setConnected(false)})
